# 选品分析用行业机会指数调整系数

> 该标准为本项目内部分析口径，不是 Amazon 官方标准。
> 用途：在保留 Oalur 原始机会指数的基础上，对不同类目风险进行解释性修正。

## 计算方式

```
行业调整后机会指数 = 原始基础机会指数 × 行业调整系数
```

报告中必须同时展示：
- 原始基础机会指数
- 行业调整系数
- 行业调整后机会指数
- 系数命中原因

## 系数表

| 类目类型 | 系数 | 适用线索 | 说明 |
|---|---:|---|---|
| 家居日用 / 厨房用品 | 1.0 | Home & Kitchen, Kitchen & Dining, Bakeware, Dining & Entertaining | 通用基准类目，不额外放宽或收紧 |
| 刚需消耗品 | 0.8 | paper, tissue, disposable, refill, filter, pet food, consumable | 复购强，但竞争通常更激烈，机会指数要求可略低 |
| 宠物消耗品 | 0.8 | Pet Supplies + food/treat/litter/pad/refill | 复购强、需求稳定，但广告和品牌竞争强 |
| 美妆个护 | 0.9 | Beauty & Personal Care, skincare, makeup, hair care | 品牌信任壁垒较高，轻微收紧 |
| 服饰鞋包 | 0.9 | Clothing, Shoes, Jewelry, Apparel, Fashion | 款式分散但退货率高、尺码复杂，轻微收紧 |
| 3C / 电子产品 | 1.2 | Electronics, Computers, Camera, Cell Phones, Bluetooth, charger | 客单价和利润空间可能更高，但质量与售后风险也高 |
| 工具 / 家装 | 1.1 | Tools & Home Improvement, Industrial & Scientific, hardware | 功能型强、客单价可做高，适当放宽 |
| 小众利基 / 专业配件 | 1.5 | replacement, accessory, parts, specialized, niche | 搜索量小但竞争少，允许较低原始机会指数 |
| 季节性强类目 | 0.8 | strong seasonality detected by report | 旺季指数会虚高，需要收紧 |
| 食品接触 / 儿童 / 医疗相关 | 0.7 | baby, kids, medical, health, food contact, silicone mold, food grade | 合规和安全风险更高，必须收紧 |

## 冲突处理

1. 若命中食品接触 / 儿童 / 医疗相关，优先使用 `0.7`。
2. 若报告判定为强季节性，优先不高于 `0.8`。
3. 若同时命中多个普通类目，选择更保守的较低系数。
4. 未命中特定规则时默认 `1.0`。
