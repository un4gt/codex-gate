#!/usr/bin/env python3
import argparse
import concurrent.futures
import json
import math
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

RSS_METRIC_NAME = 'codex_gate_process_resident_memory_bytes'


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--api-key', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--format', choices=['chat', 'responses'], default='chat')
    parser.add_argument('--requests', type=int, default=100)
    parser.add_argument('--concurrency', type=int, default=10)
    parser.add_argument('--timeout', type=float, default=30.0)
    parser.add_argument('--prompt', default='Say hello in one short sentence.')
    parser.add_argument('--duration-seconds', type=float, default=0.0)
    parser.add_argument('--gateway-pid', type=int)
    parser.add_argument('--memory-sample-interval-ms', type=int, default=500)
    parser.add_argument('--metrics-url')
    parser.add_argument('--warmup-requests', type=int, default=0)
    return parser.parse_args()


def build_payload(args):
    if args.format == 'responses':
        return json.dumps({
            'model': args.model,
            'input': args.prompt,
            'stream': False,
        }).encode('utf-8')

    return json.dumps({
        'model': args.model,
        'messages': [{'role': 'user', 'content': args.prompt}],
        'stream': False,
    }).encode('utf-8')


def percentile(values, ratio):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * ratio) - 1))
    return ordered[index]


def read_process_rss_bytes(pid):
    try:
        with open(f'/proc/{pid}/status', 'r', encoding='utf-8') as fh:
            for line in fh:
                if line.startswith('VmRSS:'):
                    parts = line.split()
                    if len(parts) >= 2:
                        return int(parts[1]) * 1024
    except Exception:
        return None
    return None


def parse_prometheus_text(text):
    metrics = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if ' ' not in line:
            continue
        name, value = line.rsplit(' ', 1)
        metrics[name] = value
    return metrics


def fetch_metrics_text(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read().decode('utf-8', errors='replace')


def read_metrics_rss_bytes(url, timeout):
    try:
        text = fetch_metrics_text(url, timeout)
        metrics = parse_prometheus_text(text)
        value = metrics.get(RSS_METRIC_NAME)
        if value is None:
            return None
        return int(float(value))
    except Exception:
        return None


def one_request(url, api_key, payload, timeout):
    started = time.perf_counter()
    request = urllib.request.Request(
        url=url,
        data=payload,
        method='POST',
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()
            status = response.getcode()
            error = None
    except urllib.error.HTTPError as exc:
        exc.read()
        status = exc.code
        error = exc.reason
    except Exception as exc:
        status = 0
        error = str(exc)

    duration_ms = (time.perf_counter() - started) * 1000.0
    return {
        'status': status,
        'ok': 200 <= status < 400,
        'duration_ms': duration_ms,
        'error': error,
    }


def run_fixed_request_count(args, payload):
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = [pool.submit(one_request, args.url, args.api_key, payload, args.timeout) for _ in range(max(1, args.requests))]
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())
    return results


def run_duration_mode(args, payload):
    results = []
    stop_at = time.perf_counter() + max(0.1, args.duration_seconds)
    lock = threading.Lock()

    def worker():
        local = []
        while time.perf_counter() < stop_at:
            local.append(one_request(args.url, args.api_key, payload, args.timeout))
        with lock:
            results.extend(local)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(max(1, args.concurrency))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def warmup(args, payload):
    if args.warmup_requests <= 0:
        return []
    warm_args = argparse.Namespace(**vars(args))
    warm_args.requests = args.warmup_requests
    warm_args.duration_seconds = 0.0
    return run_fixed_request_count(warm_args, payload)


def sample_memory(pid, metrics_url, timeout, interval_ms, stop_event, samples):
    interval_s = max(interval_ms, 50) / 1000.0
    source = 'pid' if pid else ('metrics' if metrics_url else 'none')
    while not stop_event.is_set():
        if pid:
            rss = read_process_rss_bytes(pid)
        elif metrics_url:
            rss = read_metrics_rss_bytes(metrics_url, timeout)
        else:
            rss = None
        samples.append({
            'ts': round(time.time(), 3),
            'rss_bytes': rss,
            'source': source,
        })
        time.sleep(interval_s)


def summarize_memory(samples):
    rss_values = [item['rss_bytes'] for item in samples if item.get('rss_bytes') is not None]
    if not rss_values:
        return None
    source = next((item.get('source') for item in samples if item.get('rss_bytes') is not None), None)
    return {
        'source': source,
        'samples': len(rss_values),
        'min_bytes': min(rss_values),
        'mean_bytes': round(statistics.fmean(rss_values), 2),
        'p95_bytes': percentile(rss_values, 0.95),
        'max_bytes': max(rss_values),
        'delta_bytes': max(rss_values) - min(rss_values),
    }


def main():
    args = parse_args()
    payload = build_payload(args)

    warmup_results = warmup(args, payload)
    metrics_before = None
    metrics_after = None
    if args.metrics_url:
        try:
            metrics_before = parse_prometheus_text(fetch_metrics_text(args.metrics_url, args.timeout))
        except Exception as exc:
            metrics_before = {'_error': str(exc)}

    memory_samples = []
    stop_event = threading.Event()
    sampler = None
    if args.gateway_pid or args.metrics_url:
        sampler = threading.Thread(
            target=sample_memory,
            args=(args.gateway_pid, args.metrics_url, args.timeout, args.memory_sample_interval_ms, stop_event, memory_samples),
            daemon=True,
        )
        sampler.start()

    started = time.perf_counter()
    try:
        if args.duration_seconds > 0:
            results = run_duration_mode(args, payload)
        else:
            results = run_fixed_request_count(args, payload)
    finally:
        total_elapsed = time.perf_counter() - started
        stop_event.set()
        if sampler:
            sampler.join(timeout=2.0)

    if args.metrics_url:
        try:
            metrics_after = parse_prometheus_text(fetch_metrics_text(args.metrics_url, args.timeout))
        except Exception as exc:
            metrics_after = {'_error': str(exc)}

    durations = [item['duration_ms'] for item in results]
    status_counts = Counter(str(item['status']) for item in results)
    success = sum(1 for item in results if item['ok'])
    failed = len(results) - success

    output = {
        'url': args.url,
        'format': args.format,
        'model': args.model,
        'mode': 'duration' if args.duration_seconds > 0 else 'count',
        'requests': len(results),
        'concurrency': max(1, args.concurrency),
        'warmup_requests': len(warmup_results),
        'success': success,
        'failed': failed,
        'throughput_rps': round(len(results) / total_elapsed, 3) if total_elapsed > 0 else None,
        'elapsed_s': round(total_elapsed, 3),
        'latency_ms': {
            'min': round(min(durations), 3) if durations else None,
            'mean': round(statistics.fmean(durations), 3) if durations else None,
            'p50': round(percentile(durations, 0.50), 3) if durations else None,
            'p95': round(percentile(durations, 0.95), 3) if durations else None,
            'p99': round(percentile(durations, 0.99), 3) if durations else None,
            'max': round(max(durations), 3) if durations else None,
        },
        'status_counts': dict(sorted(status_counts.items())),
        'errors': sorted({item['error'] for item in results if item['error']})[:10],
        'memory_rss': summarize_memory(memory_samples),
        'memory_samples_captured': len(memory_samples),
        'metrics_before': metrics_before,
        'metrics_after': metrics_after,
    }
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
