# 数据归属与免责声明

本项目（Earth Pulse）的**代码**采用 MIT 许可，见 [LICENSE](LICENSE)。

但项目运行时展示的**数据**来自第三方公开接口，版权归各自所有者所有。
代码许可与数据许可是两回事，使用本项目时请分别遵守。

---

## 使用的公开数据源

### USGS 地震目录
- **用途**：全球 M2.5+ 地震事件（位置、震级、深度、发生时间）
- **来源**：https://earthquake.usgs.gov/earthquakes/feed/
- **许可**：美国政府作品，属公有领域（Public Domain）
- **要求**：署名 "Data courtesy of the U.S. Geological Survey"

### Natural Earth 陆地轮廓
- **用途**：底图大陆与海岸线矢量数据
- **来源**：https://www.naturalearthdata.com/
- **许可**：公有领域（Public Domain）
- **说明**：`data/land.js` 由 `scripts/build-land.mjs` 从 110m Land 数据预处理生成

### Open-Meteo 气象与空气质量
- **用途**：温度、湿度、风力、气压、天气代码、PM2.5 / PM10 / O₃ 及 AQI
- **来源**：https://open-meteo.com/
- **许可**：CC BY 4.0
- **要求**：**必须保留署名声明**，且需包含指向 Open-Meteo 的链接
  - 官方许可条款：https://open-meteo.com/en/licence

### ISS 位置数据
- **用途**：国际空间站经纬度、轨道高度、地面足迹
- **来源**：https://wheretheiss.at/
- **许可**：公开接口，未发布正式使用条款
- **要求**：本项目已在界面中标注来源

---

## 未使用的数据源

### OpenSky Network（已排除）
其 `Access-Control-Allow-Origin` 响应头仅允许 `https://opensky-network.org`，
浏览器直连必然失败，除非自建 CORS 代理服务器 —— 那将违背本项目
「零服务端」的设计前提。因此本项目不接入该数据源。

若你自行部署了代理服务，可参考其官方 API 文档接入航班数据。

---

## 免责声明

1. 本项目是**数据可视化呈现工具**，不是预报工具，也不是决策依据。
2. 数据可能存在延迟、缺失或误差：
   - 地震目录通常有几十秒到数分钟的发布延迟
   - 气象数据为网格插值结果，而非气象站实测
   - 空间站位置为理论轨道推算值
3. 使用本项目产生的任何决策后果，由使用者自行承担。
4. 若你 fork 本项目并对外提供服务，需自行确认所用数据源的
   服务条款是否允许你的具体使用方式（尤其是否允许商业用途）。
