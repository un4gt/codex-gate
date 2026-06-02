use std::collections::HashMap;

use parking_lot::Mutex;

#[derive(Default)]
pub struct KeyRotationBook {
    offsets: Mutex<HashMap<i64, usize>>,
}

impl KeyRotationBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn rotate_provider<T: Clone>(&self, provider_id: i64, keys: &[T]) -> Vec<T> {
        if keys.len() <= 1 {
            return keys.to_vec();
        }

        let mut offsets = self.offsets.lock();
        let offset = offsets.entry(provider_id).or_insert(0);
        let start = *offset % keys.len();
        *offset = offset.wrapping_add(1) % keys.len();
        drop(offsets);

        keys[start..]
            .iter()
            .chain(keys[..start].iter())
            .cloned()
            .collect()
    }
}
