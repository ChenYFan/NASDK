# Bench

压力测试与 Simple、Full、Edge 并列，以 `echo.test.mjs` 和 `gateway.test.mjs` 为主场景，`providers/` 提供可插拔传输配置。
通过 `npm run test:bench -- echo|gateway|k6 --cpus <list> --provider <name>` 执行，参数见 `npm run test:bench -- --help`。
服务地址由环境变量配置，Grafana 使用 `GRAFANA_URL`、`GRAFANA_PROMETHEUS_URL` 和 `GRAFANA_TOKEN`，监控和工具通过 `test:bench -- up|down|metrics|grafana|prepare|upload|regression|ci` 选择。
结果和历史数据保存在仓库相对目录 `test/bench/results/`，大型负载由用户执行。
