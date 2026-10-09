Nyirusu Application Software Development Kit 是一款全双工通信协议与有限资源流式运行时，专门为长程流水线任务和远程任务执行设计。

在开始工作之前，你需要知道：

- 项目使用TypeScript编写
- 本项目原本隶属于Nyirusu Project，但可以单独拿出来作为通用框架使用
- 本项目文档基本完善，开始工作前至少保证阅读过[什么是NASDK](docs/napp/what-is-nasdk.md)。
- 本项目测试机制完善，区分Simple（简单、人类可阅读测试集）、Full（完整、覆盖率80%以上基本测试）和Edge（边缘情况测试集，专门对薄弱、限制或乱序情况进行压测）。
- 请根据实际工作情况进行测试。推荐只要做了修改就进行快速typecheck和SimpleCheck。Full Check请在完整的大任务完成后进行，Edge Check一般仅在commit前测试。
- 如果要在NyirusuProject下工作，请遵循NyirusuProject本身的约定。
