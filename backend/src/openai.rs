use hyper::body::Bytes;
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct OpenAiRequestInfo {
    pub model: Option<String>,
    pub stream: bool,
    pub include_usage: Option<bool>,
    pub has_stream_options: bool,
}

#[derive(Debug, Deserialize)]
struct OpenAiHeader {
    model: Option<String>,
    stream: Option<bool>,
    #[serde(default)]
    stream_options: Option<StreamOptions>,
}

#[derive(Debug, Deserialize)]
struct StreamOptions {
    include_usage: Option<bool>,
}

pub fn parse_request_info(body: &[u8]) -> OpenAiRequestInfo {
    let parsed = serde_json::from_slice::<OpenAiHeader>(body).ok();
    let (model, stream, stream_options) = match parsed {
        Some(v) => (v.model, v.stream.unwrap_or(false), v.stream_options),
        None => (None, false, None),
    };

    OpenAiRequestInfo {
        model,
        stream,
        include_usage: stream_options.as_ref().and_then(|s| s.include_usage),
        has_stream_options: stream_options.is_some(),
    }
}

pub fn ensure_include_usage(body: Bytes) -> Result<Bytes, String> {
    let info = parse_request_info(&body);
    if !info.stream {
        return Ok(body);
    }
    if info.include_usage == Some(true) {
        return Ok(body);
    }

    // Try to modify JSON with minimal copying.
    let mut out = Vec::with_capacity(body.len() + 48);

    let Some(root_end) = find_root_object_end(&body) else {
        // Can't confidently rewrite; keep passthrough.
        return Ok(body);
    };

    if let Some((so_val_start, so_val_end)) = find_root_key_value_span(&body, b"stream_options") {
        // stream_options exists; set include_usage inside it.
        let so_bytes = &body[so_val_start..so_val_end];
        let Some((iu_val_start_rel, iu_val_end_rel)) =
            find_object_key_value_span(so_bytes, b"include_usage")
        else {
            // No include_usage: inject into stream_options object.
            let injected = inject_include_usage_into_object(so_bytes)?;
            out.extend_from_slice(&body[..so_val_start]);
            out.extend_from_slice(&injected);
            out.extend_from_slice(&body[so_val_end..]);
            return Ok(Bytes::from(out));
        };

        // Replace include_usage value with true.
        let iu_val_start = so_val_start + iu_val_start_rel;
        let iu_val_end = so_val_start + iu_val_end_rel;

        out.extend_from_slice(&body[..iu_val_start]);
        out.extend_from_slice(b"true");
        out.extend_from_slice(&body[iu_val_end..]);
        return Ok(Bytes::from(out));
    }

    // stream_options missing: insert at root before final `}`.
    let insert_at = root_end;
    let needs_comma = {
        let mut i = insert_at;
        while i > 0 && body[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        i > 0 && body[i - 1] != b'{'
    };

    out.extend_from_slice(&body[..insert_at]);
    if needs_comma {
        out.extend_from_slice(b",");
    }
    out.extend_from_slice(br#""stream_options":{"include_usage":true}"#);
    out.extend_from_slice(&body[insert_at..]);
    Ok(Bytes::from(out))
}

fn find_root_object_end(input: &[u8]) -> Option<usize> {
    // index of the final `}` (exclusive), ignoring trailing whitespace.
    let mut i = input.len();
    while i > 0 && input[i - 1].is_ascii_whitespace() {
        i -= 1;
    }
    if i == 0 || input[i - 1] != b'}' {
        return None;
    }
    Some(i - 1)
}

fn find_root_key_value_span(input: &[u8], key: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0usize;
    // Skip whitespace
    while i < input.len() && input[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= input.len() || input[i] != b'{' {
        return None;
    }

    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;

    while i < input.len() {
        let b = input[i];
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        match b {
            b'"' => {
                // Potential key at root object depth==1.
                let at_root = depth == 1;
                let key_start = i + 1;
                in_string = true;
                escape = false;
                i += 1;

                if !at_root {
                    continue;
                }

                // Parse the key string (no unescape; keys we care are ASCII).
                while i < input.len() {
                    let c = input[i];
                    if escape {
                        escape = false;
                        i += 1;
                        continue;
                    }
                    if c == b'\\' {
                        escape = true;
                        i += 1;
                        continue;
                    }
                    if c == b'"' {
                        in_string = false;
                        break;
                    }
                    i += 1;
                }
                if in_string || i >= input.len() {
                    return None;
                }
                let key_end = i;
                let found = input.get(key_start..key_end) == Some(key);
                i += 1;

                if !found {
                    continue;
                }

                // Skip whitespace to colon
                while i < input.len() && input[i].is_ascii_whitespace() {
                    i += 1;
                }
                if i >= input.len() || input[i] != b':' {
                    continue;
                }
                i += 1;
                while i < input.len() && input[i].is_ascii_whitespace() {
                    i += 1;
                }
                let val_start = i;
                let val_end = scan_json_value_end(input, val_start)?;
                return Some((val_start, val_end));
            }
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                depth -= 1;
                i += 1;
            }
            b'[' => {
                depth += 1;
                i += 1;
            }
            b']' => {
                depth -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }

    None
}

fn find_object_key_value_span(input: &[u8], key: &[u8]) -> Option<(usize, usize)> {
    // Same as find_root_key_value_span but for any JSON object input, scanning at depth==1.
    let mut i = 0usize;
    while i < input.len() && input[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= input.len() || input[i] != b'{' {
        return None;
    }

    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;

    while i < input.len() {
        let b = input[i];
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        match b {
            b'"' => {
                let at_object = depth == 1;
                let key_start = i + 1;
                in_string = true;
                escape = false;
                i += 1;

                if !at_object {
                    continue;
                }

                while i < input.len() {
                    let c = input[i];
                    if escape {
                        escape = false;
                        i += 1;
                        continue;
                    }
                    if c == b'\\' {
                        escape = true;
                        i += 1;
                        continue;
                    }
                    if c == b'"' {
                        in_string = false;
                        break;
                    }
                    i += 1;
                }
                if in_string || i >= input.len() {
                    return None;
                }
                let key_end = i;
                let found = input.get(key_start..key_end) == Some(key);
                i += 1;

                if !found {
                    continue;
                }

                while i < input.len() && input[i].is_ascii_whitespace() {
                    i += 1;
                }
                if i >= input.len() || input[i] != b':' {
                    continue;
                }
                i += 1;
                while i < input.len() && input[i].is_ascii_whitespace() {
                    i += 1;
                }
                let val_start = i;
                let val_end = scan_json_value_end(input, val_start)?;
                return Some((val_start, val_end));
            }
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                depth -= 1;
                i += 1;
            }
            b'[' => {
                depth += 1;
                i += 1;
            }
            b']' => {
                depth -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }

    None
}

fn scan_json_value_end(input: &[u8], start: usize) -> Option<usize> {
    if start >= input.len() {
        return None;
    }
    let b = input[start];
    match b {
        b'{' | b'[' => {
            let open = b;
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth: i32 = 0;
            let mut in_string = false;
            let mut escape = false;
            let mut i = start;
            while i < input.len() {
                let c = input[i];
                if in_string {
                    if escape {
                        escape = false;
                    } else if c == b'\\' {
                        escape = true;
                    } else if c == b'"' {
                        in_string = false;
                    }
                    i += 1;
                    continue;
                }
                match c {
                    b'"' => {
                        in_string = true;
                        escape = false;
                        i += 1;
                    }
                    c if c == open => {
                        depth += 1;
                        i += 1;
                    }
                    c if c == close => {
                        depth -= 1;
                        i += 1;
                        if depth == 0 {
                            return Some(i);
                        }
                    }
                    _ => i += 1,
                }
            }
            None
        }
        b'"' => {
            let mut i = start + 1;
            let mut escape = false;
            while i < input.len() {
                let c = input[i];
                if escape {
                    escape = false;
                    i += 1;
                    continue;
                }
                if c == b'\\' {
                    escape = true;
                    i += 1;
                    continue;
                }
                if c == b'"' {
                    return Some(i + 1);
                }
                i += 1;
            }
            None
        }
        _ => {
            // primitive
            let mut i = start;
            while i < input.len() {
                let c = input[i];
                if c == b',' || c == b'}' || c == b']' || c.is_ascii_whitespace() {
                    break;
                }
                i += 1;
            }
            Some(i)
        }
    }
}

fn inject_include_usage_into_object(obj: &[u8]) -> Result<Vec<u8>, String> {
    // obj must be a JSON object.
    let mut i = 0usize;
    while i < obj.len() && obj[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= obj.len() || obj[i] != b'{' {
        return Err("stream_options is not an object".to_string());
    }

    let mut j = obj.len();
    while j > 0 && obj[j - 1].is_ascii_whitespace() {
        j -= 1;
    }
    if j == 0 || obj[j - 1] != b'}' {
        return Err("stream_options object not terminated".to_string());
    }

    let inner = &obj[i + 1..j - 1];
    let is_empty = inner.iter().all(|b| b.is_ascii_whitespace());

    let mut out = Vec::with_capacity(obj.len() + 32);
    out.extend_from_slice(&obj[..i + 1]);
    if !is_empty {
        out.extend_from_slice(br#""include_usage":true,"#);
    } else {
        out.extend_from_slice(br#""include_usage":true"#);
    }
    out.extend_from_slice(&obj[i + 1..]);
    Ok(out)
}
