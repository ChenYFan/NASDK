import{_ as p,C as d,o as n,c,a3 as t,E as i,j as a,a as l}from"./chunks/framework.BLaSdaBb.js";const k=JSON.parse('{"title":"NACP 生命周期","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/lifecycle.md","filePath":"transport/nacp/lifecycle.md","lastUpdated":1791613576000}'),r={name:"transport/nacp/lifecycle.md"};function s(A,e,b,u,f,h){const o=d("VitePressMermaid");return n(),c("div",null,[e[0]||(e[0]=t("",5)),i(o,{value:`stateDiagram-v2
    [*] --> online: Reg 成功
    online --> offline: 断连 / ACK超时 / 心跳无应答
    offline --> online: 宽限期内 Reg
    offline --> dropped: 宽限期结束
    online --> dropped: 收到 UnReg
    dropped --> [*]`}),e[1]||(e[1]=t("",25)),i(o,{value:`stateDiagram-v2
    [*] --> backlog: NACP 接收消息
    backlog --> accepting: 向 NACT 提交
    accepting --> ackPending: 本端 Provider 接纳完成
    accepting --> completed: 接纳确认前已收到 ACK
    accepting --> backlog: 链路离线
    accepting --> failed: 接纳失败 / 放弃
    ackPending --> completed: 收到 ACK
    ackPending --> backlog: 链路离线
    backlog --> failed: 逐出 / App dropped
    ackPending --> failed: 逐出 / App dropped
    completed --> [*]
    failed --> [*]`}),e[2]||(e[2]=a("p",null,[a("code",null,"BacklogTable 积压表"),l(" 保存尚未提交或等待重发的消息。提交后、Provider 接纳确认前的记录单独跟踪，不再占用 Backlog；"),a("code",null,"AckPendingTable确认表"),l(" 保存已被 Provider 接纳、正在等待 ACK 的消息。")],-1)),e[3]||(e[3]=a("h3",{id:"notify与ackmessage",tabindex:"-1"},[l("Notify与AckMessage "),a("a",{class:"header-anchor",href:"#notify与ackmessage","aria-label":'Permalink to "Notify与AckMessage"'},"​")],-1)),e[4]||(e[4]=a("p",null,"Notify 和 Ack 不等待 ACK，也不进入 AckPendingTable：",-1)),i(o,{value:`stateDiagram-v2
    [*] --> backlog: NACP 接收消息
    backlog --> completed: 本端 Provider 接纳完成
    backlog --> waiting: 目标离线
    waiting --> completed: 重连后成功发出
    backlog --> failed: 容量拒绝 / 逐出
    waiting --> failed: 容量逐出 / App dropped
    completed --> [*]: 返回 true
    failed --> [*]: 返回 false`}),e[5]||(e[5]=t("",19))])}const P=p(r,[["render",s]]);export{k as __pageData,P as default};
