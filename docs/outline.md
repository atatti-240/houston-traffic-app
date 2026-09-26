# Project Outline / 项目大纲

Houston Hackathon 2026 · Ion District
Last updated / 更新: 2026-09-25 (Fri) · Submission / 截止: Sun 2026-09-27 11:45 PM (Devpost)
Status / 状态: Brainstorming — design not yet approved / 头脑风暴中，设计未定稿
Detail + test evidence / 详细资料和测试证据: [feature-notes.md](feature-notes.md)

---

## 1. Problem / 问题
- Houston drivers lose **77 hours/year** in traffic (TTI 2025). / 休斯顿每位司机每年堵车 77 小时
- **700+ rail crossings**; Texas leads the US in blocked crossings, Houston ≥ half of Texas. / 700 多个道口，火车堵道全美最多
- Google / Apple / Waze have **blind spots** (Jessie): no live "train blocking now", weak multi-stop, no Houston local data. / 现有工具有盲区

## 2. One-sentence solution / 一句话方案
A Houston-aware day planner: tells you which stop first and when to leave, and re-plans automatically when a train blocks a crossing or a crash happens.
懂休斯顿的一日行程规划器：告诉你先去哪、几点出发，火车堵道或出事故时自动重新规划。

## 3. Decisions / 已定决策
| # | Decision / 决策 | Choice / 选择 |
|---|---|---|
| Q1 | Demo centerpiece / Demo 主角 | Live map + multi-stop planner, equal / 并重 |
| Q2 | Dynamic scheduling / 动态调度 | Auto re-plan + push **and** flexible time windows / 自动重排 + 推送 + 弹性时间窗 |
| Q3 | Platform / 平台 | Phone-friendly website, PWA for push / 手机网站 + PWA |
| Q4 | Camera AI / 摄像头 AI | YOLOv8s car counting; trains via Train Watch / YOLO 数车，火车用 Train Watch |
| Q5 | Routing / 路线 | ~~TomTom~~ → **team repo's small graph + add demo places** (2026-09-25) / 用团队仓库的小路网 |
| Q7 | Multi-stop / 多站点 | **Yes**, with time windows / 做 |
| Q8 | YOLO | **Yes** / 做 |
| Q9 | Stack / 技术栈 | Team repo: FastAPI + SQLAlchemy + uv, Next.js + TS + react-leaflet |
| — | Flooding / 积水 | Later / 以后再加 |
| Q6 | Team languages + roles / 语言和分工 | **Open** / 待定 (5 people) |

## 4. Features / 功能
### Must-have (all 5 passed spike test) / 必做（测试全部通过）
1. Crossing map — Train Watch 56 crossings / 道口地图
2. YOLO car counts — per-camera baseline, skip broken/frozen cameras / YOLO 数车
3. 3-stop planner + time windows / 3 站点规划 + 时间窗
4. Dynamic re-plan + push / 动态重排 + 推送
5. Demo replay mode / 演示回放模式

### Bonus / 加分项
- Crash risk score + safe routes — **City Vision Zero High Injury Network 2025** (public) / 事故风险分 + 安全路线
- Congestion score, moving average `new = old + α(today − old)` / 拥堵分
- Queue detection near crossings (replaces "train cameras") / 道口附近排队检测
- In-app "train blocking here" report / 用户上报火车挡道
- Waze live panel (iFrame) + one-tap navigation link / Waze 面板 + 一键导航
- Blocked-crossing report back to the city / 回馈市政府报告
- English / Spanish toggle / 英西切换

### Dropped / changed / 已删除或调整
- ~~Train cameras~~ — 0 of 14 cameras near crossings show the tracks / 道口附近摄像头拍不到铁轨
- ~~Flooding~~ — later / 以后

## 5. Schematic / 系统结构
```
LIVE (1–5 min) / 实时
  Train Watch (1 min) ─ crossing status / 道口状态
  TranStar RSS (2 min) ─ incidents, closures, travel times / 事故、封路、行车时间
  TranStar cameras (freeway ~1–2.5 min refresh) ─ validate ─ YOLOv8s ─ vs usual count
  TomTom ─ routes + speed on crossing streets / 路线 + 道口街道车速
        │
HISTORY (load once) / 历史
  TranStar historical travel times (50 routes, 2011–2025)
  Vision Zero High Injury Network 2025 (1,080 segments, 4,620 crashes, 762 deaths)
  US Accidents (Kaggle, ~170K Houston) · FRA blocked-crossing reports
        │
DATABASE / 数据库
  crossing log · camera counts + refresh times · incidents · congestion score (road × weekday × 15 min)
        │
PLANNER / 规划器
  6 orders × 9 departure times; cost = drive + wait + delay + crossing block + crash risk
  re-plan every 5 min → push on change / 每 5 分钟重排，有变化就推送
        │
PHONE WEBSITE / 手机网站
  ① trip input ② today's plan + map ③ live view (cameras, crossings, Waze) ④ alerts
  "Go" → Waze / Google Maps
```

## 6. Data sources / 数据源
| Data / 数据 | Status / 状态 |
|---|---|
| Train Watch | ✅ live, public |
| TranStar cameras | ✅ still images (freeway ~1–2.5 min; street slower), ⚠️ some broken/frozen |
| TranStar RSS | ✅ live, public |
| TranStar historical travel times | ✅ public |
| Vision Zero High Injury Network 2025 | ✅ public ArcGIS |
| TranStar JSON feeds | ❌ 403 → replaced by RSS |
| TomTom | ⏳ key not registered |
| US Accidents (Kaggle) | ⏳ needs login |
| FRA blocked-crossing reports | 🟡 page loads, export untested |

## 7. vs Waze / Google / 区别
| | Waze / Google | Us / 我们 |
|---|---|---|
| Train blocking now / 火车正在堵道 | ❌ | ✅ |
| Multi-stop + time windows / 多站点 + 时间窗 | ❌ (1 extra stop) | ✅ |
| Houston cameras / 休斯顿摄像头 | ❌ | ✅ |
| Safe routes from crash history / 安全路线 | ❌ | ✅ |

Spike evidence / 测试证据: normal day **−6 min**; 60-min train block **−54 min** → pitch disruption days. / 平常省 6 分钟，火车堵道时省 54 分钟

## 8. Risks / 风险
1. ~~Camera usage permission~~ → officials said OK (2026-09-25) / 官员已同意
2. Train Watch "sensor DOWN" meaning unknown (officials didn't know) → "low confidence" label + cross-check / 传感器离线含义不明
3. Broken / frozen cameras → validate every frame / 坏摄像头
4. Too many features → stick to must-haves / 功能太多
5. Late integration → full flow working by Sat noon / 最后才合并

## 9. To-do / 待办
| Item / 事项 | Owner / 负责 | Deadline / 截止 |
|---|---|---|
| ~~Ask officials 3 questions~~ ✅ done: cameras/RSS OK, DOWN unknown, no live access | | Fri |
| Run data logger all weekend / 周末持续记录 | | Fri tonight |
| ~~Register TomTom key~~ — not needed (small graph) / 不需要了 | | — |
| Download US Accidents / 下载事故数据 | | Sat |
| 5 roles + languages / 分工和语言 | Team | Fri tonight |
| Approve design → start building / 设计获批 → 开工 | Team | Sat morning |

## 10. Roles (5 people) / 角色分工 — PROPOSED, names TBD / 建议方案，待填名字
| Role | Owns (spec modules) | Lang | Name |
|---|---|---|---|
| A. Live data | `collectors/trainwatch`, `collectors/rss`, store schema, logger import | Python | |
| B. Camera AI | `collectors/cameras`, YOLO, per-camera baseline, stale detection, queue-near-crossing | Python | |
| C. Planner | repo prompts 5–7: `routing/`, `recommender.py`, + `multistop.py`, `api/` | Python | |
| D. Website | `web` (4 screens, Leaflet map, Waze panel), PWA + push | JS | |
| E. Safety + demo | `history/loaders`, crash risk, `replay`, drive tests vs Google, slides, Devpost | Python / any | |
Checkpoints: Sat 12:00 crude end-to-end · Sat 21:00 all must-haves · Sun 15:00 feature freeze · Sun 22:00 submit.

## Changelog / 更新记录
- 2026-09-25: first version / 第一版
- 2026-09-25: website look = Space Apps Houston style (look only, no NASA branding) → `docs/website-style.md` / 网站风格参考 NASA Space Apps
- 2026-09-25: spec approved; implementation plan written → `docs/plans/2026-09-25-houston-commute-planner-plan.md` / 设计通过，实施计划完成
- 2026-09-25: team repo reviewed (github.com/atatti-240/houston-traffic-app); decided small graph + multi-stop + YOLO; spec aligned to repo; API samples in `docs/contracts/` / 审阅团队仓库，设计文档对齐
- 2026-09-25: design spec drafted → `docs/specs/2026-09-25-houston-commute-planner-design.md`; demo trip UH Sugar Land → UH → Ion: leave by 3:55 PM (`spikes/demo_trip.py`) / 设计文档草稿 + Demo
- 2026-09-25: officials' answers added (cameras/RSS allowed; DOWN meaning unknown; no live JSON / Waze access) / 加入官员答复
