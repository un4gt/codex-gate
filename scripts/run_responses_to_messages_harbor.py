#!/usr/bin/env python3
"""Build the disposable Responses lab image and run the real Claude Code Harbor agent."""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

TASK = Path(__file__).resolve().parent / "harbor" / "responses-to-messages"
IMAGE = "codex-gate-responses-messages-harbor:local"
PROFILE_ENV_PREFIXES = ("ANTHROPIC_DEFAULT_", "CLAUDE_CODE_MAX_", "CLAUDE_CODE_AUTO_COMPACT_")
PROFILE_ENV_KEYS = {"CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "MAX_THINKING_TOKENS"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True, type=Path, help="Linux x86-64 gateway binary")
    parser.add_argument("--claude", required=True, type=Path, help="Linux x86-64 Claude Code CLI binary")
    parser.add_argument("--settings", type=Path, help="Claude Code profile for model and token-limit settings")
    parser.add_argument("--tier", choices=("opus", "sonnet", "haiku"), default="sonnet")
    parser.add_argument("--jobs-dir", type=Path, default=Path("data/harbor-jobs"))
    parser.add_argument("--legacy-builder", action="store_true", help="Build from the daemon's cached base image")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="codex-gate-harbor-") as directory:
        context = Path(directory) / "image"
        shutil.copytree(TASK / "environment", context)
        shutil.copy2(args.backend, context / "backend")
        shutil.copy2(args.claude, context / "claude-real")
        profile = {"ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-6.2-sol"}
        if args.settings:
            configured = json.loads(args.settings.read_text(encoding="utf-8-sig"))["env"]
            profile.update({key: value for key, value in configured.items()
                            if key.startswith(PROFILE_ENV_PREFIXES) or key in PROFILE_ENV_KEYS})
        if f"ANTHROPIC_DEFAULT_{args.tier.upper()}_MODEL" not in profile:
            parser.error(f"--settings must provide a model for {args.tier}")
        (context / "settings.gpt.json").write_text(json.dumps({"model": args.tier, "env": profile}), encoding="utf-8")
        env = dict(os.environ)
        build = ["docker", "build", "-t", IMAGE]
        if args.legacy_builder:
            env["DOCKER_BUILDKIT"] = "0"
        else:
            build.append("--load")
        subprocess.run([*build, str(context)], env=env, check=True)

    job_name = f"responses-to-messages-{uuid4().hex[:12]}"
    jobs_dir = args.jobs_dir.resolve()
    subprocess.run([
        "harbor", "run", "-p", str(TASK), "-a", "claude-code", "-m", args.tier,
        "-n", "1", "--jobs-dir", str(jobs_dir), "--job-name", job_name,
        "--ae", "ANTHROPIC_API_KEY=harbor-local-placeholder",
        "--ae", "ANTHROPIC_BASE_URL=http://127.0.0.1:8184",
        "--ak", "permission_mode=dontAsk", "--ak", "allowed_tools=Read,Edit,Bash",
        "--ak", "disable_web_search=true", "--ak", "max_turns=12",
        "--ak", "max_thinking_tokens=0",
    ], check=True)
    job_dir = jobs_dir / job_name
    rewards = list(job_dir.glob("*/verifier/reward.txt"))
    if len(rewards) != 1 or float(rewards[0].read_text()) != 1:
        raise SystemExit(f"Responses-to-Messages trial failed. See {job_dir}")
    summary = rewards[0].with_name("protocol-summary.json")
    print(json.dumps(json.loads(summary.read_text(encoding="utf-8")), indent=2))
    print(f"Verified Harbor trial: {job_dir}")


if __name__ == "__main__":
    main()
