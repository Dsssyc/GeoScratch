# 投影 Cell 最大拉伸设计

英文设计稿是事实基准；本文是其中文翻译。

## 目标

防止细长、强透视缩短的 terrain cell 在相机连续倾斜时被错误粗化，同时保留旋转
不变性、当前视图确定性、有界 GPU 工作，以及 ADR-087 的精确父瓦片稀疏 cover。

## 度量

对于局部 pixel-space projective Jacobian `J`，使用其最大奇异值。它表示一个几何
cell 内任意单位方向所能产生的最大屏幕位移，并且在 world-cell basis 与 screen basis
旋转下保持不变。旧的 `sqrt(abs(det(J)))` 只表达等面积尺度；当正交方向被压扁时，
它可能掩盖任意长的另一条轴。

CPU 参考实现与 WGSL kernel 都通过 `J^T J` 最大特征值的闭式解计算该值。跨越近裁剪
平面的情形继续返回 reference viewport 最大值并保守细分。

## 校准

内建 128-cell WebMercator terrain patch 使用 5 reference pixels 与 0.005 数值容差。
该值属于 consumer policy，不是全局 cover 默认值。在标准 1280×800、zoom 10 的
MapLibre 视图中，俯视仍为 8 patches；从 0 到 85 度的每个整数 pitch 都不会出现
settled patch-count 回退，峰值为 88/512。

## 验证

- 各向异性 CPU 投影必须比等面积各向同性投影细分得更深；
- 稀疏父瓦片、prefix-free、确定性与 2:1 测试保持通过；
- 原生 Chrome pitch sweep 包含 86 个 settled 样本，不得粗化、溢出或出现大于 1 的
  邻接层级差；
- 着色/线框 tracking 与 DPR 不变性继续满足既有延迟和身份门禁。

