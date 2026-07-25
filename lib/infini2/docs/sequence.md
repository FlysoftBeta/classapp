Sequence 需要高效地:
- 获得片段和/前缀和
- 获得顺序排列
- 任意位置插入

Sequence 是一个 Implicit Treap，不记录索引，通过子树之间的关系来表达顺序语义：

```
seq(x) = seq(x.left) + [x] + seq(x.right)
```

顺序即为中序遍历该树的顺序。

即，满足左子树中所有元素一定在本元素前，右子树中所有元素一定在本元素后。

因此 Implicit Treap 的重平衡也是可接受的。

Treap 的重平衡：

根据 seq 的定义： seq = 中序遍历，树的旋转不影响 seq。 

```
seq(x) = seq(A) + [x] + (seq(B) + [y] + seq(C)) = seq(A) + [x] + seq(y)
等价于
seq(y) = (seq(A) + [x] + seq(B)) + [y] + seq(C) = seq(x) + [y] + seq(C)
```