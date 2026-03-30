use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;

pub fn derive_32(master_key: &str) -> [u8; 32] {
    let digest = blake3::hash(master_key.as_bytes());
    *digest.as_bytes()
}

pub fn hash_api_key(master_key: &str, api_key_plaintext: &str) -> String {
    // Fast keyed hash for lookup; not a password hash.
    // We intentionally do not store plaintext API keys.
    let mut hasher = blake3::Hasher::new();
    hasher.update(master_key.as_bytes());
    hasher.update(b"\0");
    hasher.update(api_key_plaintext.as_bytes());
    hex::encode(hasher.finalize().as_bytes())
}

pub fn encrypt_secret(master_key: &str, plaintext: &str) -> Result<String, String> {
    let key = derive_32(master_key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;

    let mut nonce_bytes = [0u8; 12];
    use aes_gcm::aead::rand_core::RngCore;
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;

    // Store as base64(nonce || ciphertext)
    let mut blob = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);

    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(blob))
}

pub fn decrypt_secret(master_key: &str, blob_b64: &str) -> Result<String, String> {
    let key = derive_32(master_key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;

    let blob = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(blob_b64)
        .map_err(|e| e.to_string())?;
    if blob.len() < 12 {
        return Err("encrypted secret blob too short".to_string());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| e.to_string())?;

    String::from_utf8(plaintext).map_err(|e| e.to_string())
}
