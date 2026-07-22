use std::collections::HashMap;

use crate::types::{Diagnostics, Handle, Item, ItemSnapshot, INVALID_HANDLE};

type NodeId = usize;

#[derive(Clone, Debug)]
struct Node {
    item: Item,
    priority: u32,
    left: Option<NodeId>,
    right: Option<NodeId>,
    parent: Option<NodeId>,
    subtree_len: u32,
    subtree_extent: f64,
}

impl Node {
    fn new(item: Item) -> Self {
        Self {
            priority: priority_for(item.handle),
            item,
            left: None,
            right: None,
            parent: None,
            subtree_len: 1,
            subtree_extent: item.extent,
        }
    }
}

fn priority_for(handle: Handle) -> u32 {
    let mut value = handle.wrapping_add(0x9e37_79b9);
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^ (value >> 16)
}

#[derive(Default)]
pub struct Sequence {
    root: Option<NodeId>,
    nodes: Vec<Option<Node>>,
    free: Vec<NodeId>,
    by_handle: HashMap<Handle, NodeId>,
}

impl Sequence {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> u32 {
        self.len_of(self.root)
    }

    pub fn is_empty(&self) -> bool {
        self.root.is_none()
    }

    pub fn total_extent(&self) -> f64 {
        self.extent_of(self.root)
    }

    pub fn contains(&self, handle: Handle) -> bool {
        handle != INVALID_HANDLE && self.by_handle.contains_key(&handle)
    }

    pub fn insert_at(&mut self, index: u32, item: Item, diagnostics: &mut Diagnostics) -> bool {
        if item.handle == INVALID_HANDLE || self.contains(item.handle) || index > self.len() {
            return false;
        }
        let node = self.alloc(item);
        diagnostics.touch();
        let (left, right) = self.split(self.root, index, diagnostics);
        let joined = self.merge(left, Some(node), diagnostics);
        self.root = self.merge(joined, right, diagnostics);
        self.set_parent(self.root, None, diagnostics);
        true
    }

    pub fn insert_batch(
        &mut self,
        index: u32,
        items: &[Item],
        diagnostics: &mut Diagnostics,
    ) -> Vec<Handle> {
        let mut inserted = Vec::new();
        let mut cursor = index.min(self.len());
        for &item in items {
            if self.insert_at(cursor, item, diagnostics) {
                inserted.push(item.handle);
                cursor = cursor.saturating_add(1);
            }
        }
        inserted
    }

    pub fn delete(
        &mut self,
        handle: Handle,
        diagnostics: &mut Diagnostics,
    ) -> Option<ItemSnapshot> {
        let node_id = *self.by_handle.get(&handle)?;
        let index = self.rank(handle, diagnostics)?;
        let start = self.offset_of(handle, diagnostics)?;
        let item = self.node(node_id).item;
        let (left, tail) = self.split(self.root, index, diagnostics);
        let (removed, right) = self.split(tail, 1, diagnostics);
        debug_assert_eq!(removed, Some(node_id));
        self.root = self.merge(left, right, diagnostics);
        self.set_parent(self.root, None, diagnostics);
        self.by_handle.remove(&handle);
        self.nodes[node_id] = None;
        self.free.push(node_id);
        diagnostics.touch();
        Some(ItemSnapshot {
            handle,
            index,
            start,
            extent: item.extent,
            measured: item.measured,
        })
    }

    pub fn measure(&mut self, handle: Handle, extent: f64, diagnostics: &mut Diagnostics) -> bool {
        if !extent.is_finite() || extent <= 0.0 {
            return false;
        }
        let Some(&node_id) = self.by_handle.get(&handle) else {
            return false;
        };
        if (self.node(node_id).item.extent - extent).abs() < 0.01
            && self.node(node_id).item.measured
        {
            return false;
        }
        {
            let node = self.node_mut(node_id);
            node.item.extent = extent;
            node.item.measured = true;
        }
        diagnostics.touch();
        self.pull_ancestors(Some(node_id), diagnostics);
        true
    }

    pub fn item(&self, handle: Handle, diagnostics: &mut Diagnostics) -> Option<ItemSnapshot> {
        let node_id = *self.by_handle.get(&handle)?;
        let index = self.rank(handle, diagnostics)?;
        let start = self.offset_of(handle, diagnostics)?;
        let item = self.node(node_id).item;
        Some(ItemSnapshot {
            handle,
            index,
            start,
            extent: item.extent,
            measured: item.measured,
        })
    }

    pub fn handle_at(&self, index: u32, diagnostics: &mut Diagnostics) -> Option<Handle> {
        if index >= self.len() {
            return None;
        }
        let mut current = self.root?;
        let mut remaining = index;
        loop {
            diagnostics.visit();
            let left_len = self.len_of(self.node(current).left);
            if remaining < left_len {
                current = self.node(current).left?;
            } else if remaining == left_len {
                return Some(self.node(current).item.handle);
            } else {
                remaining -= left_len + 1;
                current = self.node(current).right?;
            }
        }
    }

    pub fn rank(&self, handle: Handle, diagnostics: &mut Diagnostics) -> Option<u32> {
        let mut current = *self.by_handle.get(&handle)?;
        let mut rank = self.len_of(self.node(current).left);
        diagnostics.visit();
        while let Some(parent) = self.node(current).parent {
            diagnostics.visit();
            if self.node(parent).right == Some(current) {
                rank = rank
                    .saturating_add(self.len_of(self.node(parent).left))
                    .saturating_add(1);
            }
            current = parent;
        }
        Some(rank)
    }

    pub fn offset_of(&self, handle: Handle, diagnostics: &mut Diagnostics) -> Option<f64> {
        let mut current = *self.by_handle.get(&handle)?;
        let mut offset = self.extent_of(self.node(current).left);
        diagnostics.visit();
        while let Some(parent) = self.node(current).parent {
            diagnostics.visit();
            if self.node(parent).right == Some(current) {
                offset += self.extent_of(self.node(parent).left) + self.node(parent).item.extent;
            }
            current = parent;
        }
        Some(offset)
    }

    pub fn layout_range(
        &self,
        start: f64,
        end: f64,
        diagnostics: &mut Diagnostics,
    ) -> Vec<ItemSnapshot> {
        let mut output = Vec::new();
        if end <= start || self.root.is_none() {
            return output;
        }
        self.collect_layout(self.root, 0, 0.0, start, end, &mut output, diagnostics);
        output
    }

    pub fn snapshots(&self, diagnostics: &mut Diagnostics) -> Vec<ItemSnapshot> {
        let mut output = Vec::with_capacity(self.len() as usize);
        self.collect_all(self.root, 0, 0.0, &mut output, diagnostics);
        output
    }

    pub fn first_index_intersecting(
        &self,
        offset: f64,
        diagnostics: &mut Diagnostics,
    ) -> Option<u32> {
        if self.root.is_none() {
            return None;
        }
        if offset <= 0.0 {
            return Some(0);
        }
        if offset >= self.total_extent() {
            return Some(self.len().saturating_sub(1));
        }
        let mut current = self.root?;
        let mut base_index = 0;
        let mut base_offset = 0.0;
        loop {
            diagnostics.visit();
            let left = self.node(current).left;
            let left_len = self.len_of(left);
            let left_extent = self.extent_of(left);
            let item_start = base_offset + left_extent;
            let item_end = item_start + self.node(current).item.extent;
            if offset < item_start {
                current = left?;
            } else if offset < item_end {
                return Some(base_index + left_len);
            } else {
                base_index += left_len + 1;
                base_offset = item_end;
                current = self.node(current).right?;
            }
        }
    }

    fn collect_layout(
        &self,
        root: Option<NodeId>,
        base_index: u32,
        base_offset: f64,
        query_start: f64,
        query_end: f64,
        output: &mut Vec<ItemSnapshot>,
        diagnostics: &mut Diagnostics,
    ) {
        let Some(node_id) = root else {
            return;
        };
        diagnostics.visit();
        let node = self.node(node_id);
        if base_offset >= query_end || base_offset + node.subtree_extent <= query_start {
            return;
        }
        let left = node.left;
        let left_len = self.len_of(left);
        let left_extent = self.extent_of(left);
        self.collect_layout(
            left,
            base_index,
            base_offset,
            query_start,
            query_end,
            output,
            diagnostics,
        );
        let item_start = base_offset + left_extent;
        let item_end = item_start + node.item.extent;
        if item_start < query_end && item_end > query_start {
            output.push(ItemSnapshot {
                handle: node.item.handle,
                index: base_index + left_len,
                start: item_start,
                extent: node.item.extent,
                measured: node.item.measured,
            });
            diagnostics.emit();
        }
        self.collect_layout(
            node.right,
            base_index + left_len + 1,
            item_end,
            query_start,
            query_end,
            output,
            diagnostics,
        );
    }

    fn collect_all(
        &self,
        root: Option<NodeId>,
        base_index: u32,
        base_offset: f64,
        output: &mut Vec<ItemSnapshot>,
        diagnostics: &mut Diagnostics,
    ) {
        let Some(node_id) = root else {
            return;
        };
        diagnostics.visit();
        let node = self.node(node_id);
        let left_len = self.len_of(node.left);
        let left_extent = self.extent_of(node.left);
        self.collect_all(node.left, base_index, base_offset, output, diagnostics);
        let start = base_offset + left_extent;
        output.push(ItemSnapshot {
            handle: node.item.handle,
            index: base_index + left_len,
            start,
            extent: node.item.extent,
            measured: node.item.measured,
        });
        diagnostics.emit();
        self.collect_all(
            node.right,
            base_index + left_len + 1,
            start + node.item.extent,
            output,
            diagnostics,
        );
    }

    fn split(
        &mut self,
        root: Option<NodeId>,
        index: u32,
        diagnostics: &mut Diagnostics,
    ) -> (Option<NodeId>, Option<NodeId>) {
        let Some(node_id) = root else {
            return (None, None);
        };
        diagnostics.visit();
        let left_len = self.len_of(self.node(node_id).left);
        if index <= left_len {
            let left = self.node(node_id).left;
            let (before, after) = self.split(left, index, diagnostics);
            self.node_mut(node_id).left = after;
            self.set_parent(after, Some(node_id), diagnostics);
            self.pull(node_id, diagnostics);
            self.set_parent(before, None, diagnostics);
            self.set_parent(Some(node_id), None, diagnostics);
            (before, Some(node_id))
        } else {
            let right = self.node(node_id).right;
            let (before, after) = self.split(right, index - left_len - 1, diagnostics);
            self.node_mut(node_id).right = before;
            self.set_parent(before, Some(node_id), diagnostics);
            self.pull(node_id, diagnostics);
            self.set_parent(Some(node_id), None, diagnostics);
            self.set_parent(after, None, diagnostics);
            (Some(node_id), after)
        }
    }

    fn merge(
        &mut self,
        left: Option<NodeId>,
        right: Option<NodeId>,
        diagnostics: &mut Diagnostics,
    ) -> Option<NodeId> {
        match (left, right) {
            (None, other) | (other, None) => {
                self.set_parent(other, None, diagnostics);
                other
            }
            (Some(left_id), Some(right_id)) => {
                diagnostics.visit();
                if self.node(left_id).priority <= self.node(right_id).priority {
                    let left_right = self.node(left_id).right;
                    let merged = self.merge(left_right, Some(right_id), diagnostics);
                    self.node_mut(left_id).right = merged;
                    self.set_parent(merged, Some(left_id), diagnostics);
                    self.pull(left_id, diagnostics);
                    self.set_parent(Some(left_id), None, diagnostics);
                    Some(left_id)
                } else {
                    let right_left = self.node(right_id).left;
                    let merged = self.merge(Some(left_id), right_left, diagnostics);
                    self.node_mut(right_id).left = merged;
                    self.set_parent(merged, Some(right_id), diagnostics);
                    self.pull(right_id, diagnostics);
                    self.set_parent(Some(right_id), None, diagnostics);
                    Some(right_id)
                }
            }
        }
    }

    fn alloc(&mut self, item: Item) -> NodeId {
        let node = Node::new(item);
        let id = if let Some(id) = self.free.pop() {
            self.nodes[id] = Some(node);
            id
        } else {
            self.nodes.push(Some(node));
            self.nodes.len() - 1
        };
        self.by_handle.insert(item.handle, id);
        id
    }

    fn pull_ancestors(&mut self, mut current: Option<NodeId>, diagnostics: &mut Diagnostics) {
        while let Some(node_id) = current {
            self.pull(node_id, diagnostics);
            current = self.node(node_id).parent;
        }
    }

    fn pull(&mut self, node_id: NodeId, diagnostics: &mut Diagnostics) {
        let left = self.node(node_id).left;
        let right = self.node(node_id).right;
        let len = 1 + self.len_of(left) + self.len_of(right);
        let extent = self.node(node_id).item.extent + self.extent_of(left) + self.extent_of(right);
        let node = self.node_mut(node_id);
        node.subtree_len = len;
        node.subtree_extent = extent;
        diagnostics.touch();
    }

    fn set_parent(
        &mut self,
        node: Option<NodeId>,
        parent: Option<NodeId>,
        diagnostics: &mut Diagnostics,
    ) {
        if let Some(node_id) = node {
            if self.node(node_id).parent != parent {
                self.node_mut(node_id).parent = parent;
                diagnostics.touch();
            }
        }
    }

    fn len_of(&self, node: Option<NodeId>) -> u32 {
        node.map_or(0, |id| self.node(id).subtree_len)
    }

    fn extent_of(&self, node: Option<NodeId>) -> f64 {
        node.map_or(0.0, |id| self.node(id).subtree_extent)
    }

    fn node(&self, id: NodeId) -> &Node {
        self.nodes[id]
            .as_ref()
            .expect("internal Infini2 sequence node must be live")
    }

    fn node_mut(&mut self, id: NodeId) -> &mut Node {
        self.nodes[id]
            .as_mut()
            .expect("internal Infini2 sequence node must be live")
    }

    #[cfg(test)]
    pub fn validate(&self) {
        let mut seen = HashMap::new();
        let (len, extent) = self.validate_node(self.root, None, &mut seen);
        assert_eq!(len, self.len());
        assert!((extent - self.total_extent()).abs() < 1e-8);
        assert_eq!(seen.len(), self.by_handle.len());
        for (&handle, &node_id) in &self.by_handle {
            assert_eq!(seen.get(&handle), Some(&node_id));
        }
    }

    #[cfg(test)]
    fn validate_node(
        &self,
        root: Option<NodeId>,
        parent: Option<NodeId>,
        seen: &mut HashMap<Handle, NodeId>,
    ) -> (u32, f64) {
        let Some(node_id) = root else {
            return (0, 0.0);
        };
        let node = self.node(node_id);
        assert_eq!(node.parent, parent);
        if let Some(left) = node.left {
            assert!(node.priority <= self.node(left).priority);
        }
        if let Some(right) = node.right {
            assert!(node.priority <= self.node(right).priority);
        }
        assert!(seen.insert(node.item.handle, node_id).is_none());
        let left = self.validate_node(node.left, Some(node_id), seen);
        let right = self.validate_node(node.right, Some(node_id), seen);
        let expected = (left.0 + right.0 + 1, left.1 + right.1 + node.item.extent);
        assert_eq!(node.subtree_len, expected.0);
        assert!((node.subtree_extent - expected.1).abs() < 1e-8);
        expected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(handle: Handle, extent: f64) -> Item {
        Item {
            handle,
            extent,
            measured: false,
        }
    }

    #[test]
    fn incremental_order_and_extent() {
        let mut sequence = Sequence::new();
        let mut diagnostics = Diagnostics::default();
        assert!(sequence.insert_at(0, item(1, 10.0), &mut diagnostics));
        assert!(sequence.insert_at(1, item(3, 30.0), &mut diagnostics));
        assert!(sequence.insert_at(1, item(2, 20.0), &mut diagnostics));
        assert_eq!(sequence.len(), 3);
        assert_eq!(sequence.total_extent(), 60.0);
        assert_eq!(sequence.rank(2, &mut diagnostics), Some(1));
        assert_eq!(sequence.offset_of(3, &mut diagnostics), Some(30.0));
        sequence.validate();
    }

    #[test]
    fn delete_and_measure_preserve_aggregates() {
        let mut sequence = Sequence::new();
        let mut diagnostics = Diagnostics::default();
        sequence.insert_batch(
            0,
            &[item(1, 10.0), item(2, 10.0), item(3, 10.0)],
            &mut diagnostics,
        );
        assert!(sequence.measure(2, 25.0, &mut diagnostics));
        assert_eq!(sequence.offset_of(3, &mut diagnostics), Some(35.0));
        assert_eq!(sequence.delete(1, &mut diagnostics).unwrap().index, 0);
        assert_eq!(sequence.offset_of(3, &mut diagnostics), Some(25.0));
        sequence.validate();
    }

    #[test]
    fn layout_query_is_half_open() {
        let mut sequence = Sequence::new();
        let mut diagnostics = Diagnostics::default();
        sequence.insert_batch(
            0,
            &[item(1, 10.0), item(2, 10.0), item(3, 10.0)],
            &mut diagnostics,
        );
        let rows = sequence.layout_range(10.0, 20.0, &mut diagnostics);
        assert_eq!(
            rows.iter().map(|row| row.handle).collect::<Vec<_>>(),
            vec![2]
        );
    }

    #[test]
    fn randomized_operations_match_a_vec_oracle() {
        let mut sequence = Sequence::new();
        let mut oracle: Vec<Item> = Vec::new();
        let mut diagnostics = Diagnostics::default();
        let mut seed = 0x5eed_1234_u32;
        let mut next_handle = 1_u32;

        let mut random = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed
        };
        for step in 0..5_000 {
            let choice = random() % 3;
            if choice == 0 || oracle.is_empty() {
                let index = (random() as usize) % (oracle.len() + 1);
                let value = item(next_handle, 1.0 + f64::from(random() % 200));
                assert!(sequence.insert_at(index as u32, value, &mut diagnostics));
                oracle.insert(index, value);
                next_handle += 1;
            } else if choice == 1 {
                let index = (random() as usize) % oracle.len();
                let removed = oracle.remove(index);
                assert_eq!(
                    sequence
                        .delete(removed.handle, &mut diagnostics)
                        .unwrap()
                        .index,
                    index as u32
                );
            } else {
                let index = (random() as usize) % oracle.len();
                let mut extent = 1.0 + f64::from(random() % 200);
                if oracle[index].measured && (oracle[index].extent - extent).abs() < 0.01 {
                    extent = if extent >= 200.0 { 1.0 } else { extent + 1.0 };
                }
                oracle[index].extent = extent;
                oracle[index].measured = true;
                assert!(sequence.measure(oracle[index].handle, extent, &mut diagnostics));
            }

            if step % 37 == 0 {
                sequence.validate();
                let rows = sequence.snapshots(&mut diagnostics);
                assert_eq!(rows.len(), oracle.len());
                let mut offset = 0.0;
                for (index, (row, expected)) in rows.iter().zip(&oracle).enumerate() {
                    assert_eq!(row.handle, expected.handle);
                    assert_eq!(row.index, index as u32);
                    assert!((row.start - offset).abs() < 1e-8);
                    assert!((row.extent - expected.extent).abs() < 1e-8);
                    offset += expected.extent;
                }
                assert!((sequence.total_extent() - offset).abs() < 1e-8);
            }
        }
        sequence.validate();
    }

    #[test]
    fn layout_query_stays_logarithmic_at_one_hundred_thousand_items() {
        let mut sequence = Sequence::new();
        let mut setup = Diagnostics::default();
        let values = (1..=100_000)
            .map(|handle| item(handle, 10.0))
            .collect::<Vec<_>>();
        sequence.insert_batch(0, &values, &mut setup);
        sequence.validate();

        let mut query = Diagnostics::default();
        let rows = sequence.layout_range(543_210.0, 543_230.0, &mut query);
        assert_eq!(rows.len(), 2);
        assert!(query.visited < 256, "visited {} nodes", query.visited);
    }
}
