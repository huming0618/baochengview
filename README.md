# 宝成慢车 / BaochengView

宝成铁路（宝鸡↔成都）慢车沿线地图，展示经典山岳铁路的线路与车站。

## 功能

- 🗺️ 深色风格地图，适合手机浏览
- 🔍 车站搜索（支持拼音/汉字）
- 📍 点击车站查看详情
- 🎯 一键适配全线视图
- 🔗 深度链接支持（如 `?q=江油` 或 `#广元`）
- 🈶 内置中文字体子集（Android WebView 无系统 CJK 时仍可显示）
- 📍 实时定位 / 跟随（蓝点 + 精度圈；首次点击「定位」时请求权限）

## 运行

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建生产版本
npm run build

# 预览生产版本
npm run preview
```


## Android 离线 APK

Capacitor 6 + 沿线离线底图（宝鸡↔成都走廊，z7–z11）。

```bash
npm install
npm run seed-offline-tiles   # 可选：重下沿线瓦片
npm run build:android
cd android && ./gradlew assembleDebug
```

- App ID: `com.huming.baochengview`
- 应用名: 宝成慢车
- 瓦片加载顺序: 内置 offline-tiles → Cache API → 在线 Carto dark_all → OSM（已移除 Esri）
- 发布包: [android-offline-v4](https://github.com/huming0618/baochengview/releases/tag/android-offline-v4)（实时定位）
- 内置 Noto Sans SC 子集字体，修复部分 Android WebView 中文显示为 □（tofu）

## 数据来源

车站与线路数据来自 [OpenStreetMap](https://www.openstreetmap.org/)，基于 OSM 关系 [1912130](https://www.openstreetmap.org/relation/1912130)（宝成线）。

数据已预先提取为静态 GeoJSON（`public/baocheng.geojson`），无需运行时 API 调用。

### 车站列表（北→南）

| 序号 | 站名 | 备注 |
|-----|------|------|
| 1 | 宝鸡 | 北端终点站 |
| 2 | 秦岭 | |
| 3 | 红花铺 | |
| 4 | 凤州 | |
| 5 | 凤县 | |
| 6 | 宏庆 | |
| 7 | 李家河 | |
| 8 | 王家沱 | OSM 原数据未标注站名 |
| 9 | 徽县 | |
| 10 | 白水江 | |
| 11 | 红卫坝 | |
| 12 | 马蹄湾 | |
| 13 | 徐家坪 | |
| 14 | 横现河 | |
| 15 | 略阳 | |
| 16 | 乐素河 | |
| 17 | 高潭子 | |
| 18 | 巨亭 | |
| 19 | 阳平关 | |
| 20 | 燕子砭 | |
| 21 | 大滩 | |
| 22 | 朝天南 | |
| 23 | 冉家河 | |
| 24 | 广元 | |
| 25 | 昭化 | |
| 26 | 沙溪坝 | |
| 27 | 马角坝 | |
| 28 | 江油 | |
| 29 | 绵阳 | |
| 30 | 德阳 | |
| 31 | 广汉 | |
| 32 | 成都 | 南端终点站 |

**注意**：部分支线车站或临时停靠站可能未包含。数据基于 OSM 2026年7月版本。

### 已知缺失

- OSM 中宝成线关系未包含宝鸡站与成都站节点，本项目使用已知坐标补充
- 第8站"王家沱"在 OSM 原数据中未标注站名，根据位置推断

## 技术栈

- [Vite](https://vite.dev/) - 构建工具
- [Leaflet](https://leafletjs.com/) - 地图库
- [TypeScript](https://www.typescriptlang.org/) - 类型安全
- [CARTO Dark](https://carto.com/basemaps/) - 底图样式

## 许可

地图数据 © OpenStreetMap 贡献者，采用 [ODbL](https://opendatacommons.org/licenses/odbl/) 许可。

代码采用 MIT 许可。
