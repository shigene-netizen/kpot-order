# 广告起步投放 — Google Ads + Meta Ads

> 前提：**先把 Google 商家资料、照片、评价、桌卡做完再投广告。**
> 广告买来的人点进去看到一个空资料页，钱是白花的。建议至少做完
> [google-business.md](google-business.md) 的第 1、2、4、6 节。

好消息：**不需要装任何统计代码也能算清 ROI**。广告链接带自己的 `?src=`，
订单会记下来并出现在导出的 CSV 里。所以"这 300 块广告费带回多少单"是个能算出来的数。

---

## 一、Meta Ads（Facebook + Instagram）— 先投这个

**为什么先投 Meta**：餐饮行业里 Meta 的"让人想吃"比 Google 的"让人搜"更便宜，
而且能按 3 英里半径 + 兴趣精准打。Google 搜索广告更准但更贵、量更小。

### 设置

| 项 | 值 |
|---|---|
| 目标 | **流量（Traffic）** |
| 预算 | **$10/天**（跑满 7 天再判断，别 3 天就停） |
| 版位 | 只选 **Facebook Feed + Instagram Feed + Reels + Stories**，关掉 Audience Network |
| 地区 | **Atlanta, GA 半径 3 英里**（以店铺地址 `2955 Cobb Pkwy SE` 为圆心） |
| 年龄 | 22–45 |
| 语言 | 英语 |
| 兴趣 | `Hot pot` · `Asian food` · `Bubble tea` · `Korean food` · `Truist Park` · `Atlanta Braves` · `Food delivery` |
| 链接 | `https://order.kpotexpress.com/?src=meta-ads` |

> 如果之后想分广告组测不同人群，每组换一个 src：
> `?src=meta-office`（写字楼兴趣）、`?src=meta-boba`（boba 兴趣）、`?src=meta-braves`（棒球兴趣）。
> 一周后看 CSV 里哪个 src 出单多，就把预算全压到那个组。

### 文案（直接复制）

**主文案 A（主打一人一碗）**
> Hot pot without the shared pot. Build your own bowl from $15.99 — six
> broths, five noodles, your pick of protein. Ready in ~20 minutes, free
> delivery within 2 miles.

**主文案 B（主打距离/场景）**
> Cumberland's build-your-own hot pot spot. A short walk from Truist Park,
> free delivery to every office within 2 miles. Bowls from $15.99, boba from $4.50.

**主文案 C（主打折扣）**
> First order? 10% off with code KPOTEXJ01. Build-your-own hot pot bowls,
> BBQ bowls, wings and boba — order and pay on your phone.

**标题（30 字符内）**
> `Hot Pot Bowls from $15.99`
> `Free Delivery · 2 Miles`
> `Order & Pay On Your Phone`

**按钮**：`Order Now` / `Learn More`

### 图片/视频素材（按优先级）

1. **Day 1 那张俯拍碗**（Instagram 第一张）— 直接用它
2. 15 秒 Reel：空碗 → 配料 → 成品（第 3 天那条）
3. 柜台卡实拍（有 QR 的那种）
4. 波霸奶茶特写

一条素材跑 7 天，点击率低于 1.5% 就换图，**别改文案先改图**。

### 多少钱算合理

| 指标 | 及格 | 好 |
|---|---|---|
| 单次点击成本（CPC） | < $2.50 | < $1.50 |
| 点击率（CTR） | > 1.5% | > 3% |
| 每单成本 | < $6 | < $3 |

算法：广告花费 ÷ CSV 里 `source = meta-ads` 的订单数。
$10/天跑一个月是 $300，如果带回 60 单（每单 $5），对一个平均 $18 的客单价来说
**已经打平**（还没算这些客人以后再来）。

---

## 二、Google Ads（搜索广告）— 第二步再投

**为什么第二**：搜 "hotpot near me" 的人意图最准，但贵（亚特兰大餐饮词
$2–4/点击），而且量小。等 Meta 跑通了、评价有 10 条以上再开。

### 设置

| 项 | 值 |
|---|---|
| 广告系列类型 | **搜索（Search）** |
| 预算 | **$12/天** |
| 出价策略 | 手动 CPC，上限 **$3.00**（前两周），之后改成"尽可能提高转化" |
| 地区 | 半径 **5 英里**（比 Meta 大一点，搜的人本来就少） |
| 链接 | `https://order.kpotexpress.com/?src=google-ads` |

### 关键词（词组匹配 / 完全匹配，别用广泛匹配）

**高意图（主要出价）**
```
"hot pot near me"
"hotpot near me"
"hot pot atlanta"
"hot pot delivery near me"
"hot pot cumberland"
"hot pot marietta"
"hot pot smyrna"
"build your own hot pot"
"korean fried chicken near me"
"boba near me"
"bubble tea atlanta"
"hot pot truist park"
```

**否定关键词（必须加，否则一半预算浪费）**
```
recipe, how to, at home, diy, pot, cooker, slow cooker, instant pot,
fondue, free, cheap, recipe, ingredients, broth recipe, hot pot pot,
electric, induction, set, machine
```

### 广告文案（直接复制）

**标题 1–15 条**（每条 30 字符内，Google 会自己组合）
```
Hot Pot Bowls From $15.99
Build Your Own Bowl
Free Delivery Within 2 Miles
Order & Pay On Your Phone
Ready In About 20 Minutes
Cumberland · Near Truist Park
BBQ Protein Bowls $12.99
Boba & Fruit Teas From $4.50
Open Today Until 9:30 PM
Korean Fried Chicken Wings
6 Broths · 2 Vegetarian
Pickup · Delivery · Dine-In
KPOT To Go · Atlanta
Call (678) 335-5388
Skip The Line — Order Online
```

**描述 1–4 条**（90 字符内）
```
Build-your-own hot pot bowls from $15.99. Pick broth, noodles, protein and veg. Ready in ~20 min.
Free delivery within 2 miles. $10 minimum. Order and pay on your phone, skip the line.
BBQ protein bowls from $12.99. Boba and fruit teas from $4.50. Dine in, pick up or delivery.
A short walk from Truist Park. Six broths including vegetarian options. Open 7 days.
```

**附加信息（sitelinks / callouts，免费，一定要加）**
- `Order Online` → `https://order.kpotexpress.com/`
- `Call Us` → `tel:+16783355388`
- `Free Delivery` → `Within 2 miles · $10 minimum`
- `Hours` → `Sun–Thu 12–9:30 · Fri–Sat 12–10:30`

---

## 三、什么时候停

- **Meta**：跑满 7 天。如果 CTR < 1% 且 CPC > $3，换图再跑 7 天；
  还不行就停，问题大概率在落地页（照片/评价不够）。
- **Google**：跑满 14 天。看 CSV 里 `source = google-ads` 的订单数。
  每单成本 > $10 就停掉，回去做评价和照片。

**永远不要**：一边投广告一边改网站。一个变量一个变量来，否则你不知道是什么起了作用。

---

## 四、不花钱的"广告"

按效果排序，这些都比 $10/天的广告值：

1. **Google 商家资料帖子**（每周 1–2 条，免费，出现在搜索结果里）— 见 google-business.md 第 7 节
2. **Nextdoor 商家页** — 邻里 App，本地餐饮转化极高，几乎没人竞争
3. **请 5 个本地美食小博主免费吃** — 1k–20k 粉丝的号，免费换发帖，成本是一桌菜。模板见 outreach.md
4. **写字楼扫楼** — Cumberland 一圈写字楼，前台递传单 + 留 10 张 10% off 码
5. **Truist Park 比赛日** — 30339 邮编的天然流量，比赛日前一天发帖、当天推外送
