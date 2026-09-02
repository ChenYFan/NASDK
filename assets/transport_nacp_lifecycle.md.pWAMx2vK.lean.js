import{_ as d,C as n,o as p,c,a3 as t,E as l,j as a,a as i}from"./chunks/framework.BLaSdaBb.js";const g=JSON.parse('{"title":"NACP 生命周期","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/lifecycle.md","filePath":"transport/nacp/lifecycle.md","lastUpdated":1788343005000}'),r={name:"transport/nacp/lifecycle.md"};function s(b,e,u,A,f,h){const o=n("VitePressMermaid");return p(),c("div",null,[e[0]||(e[0]=t("",5)),l(o,{value:`stateDiagram-v2
    [*] --> online: Reg 成功
    online --> offline: 断连 / ACK超时
    offline --> online: 宽限期内 Reg
    offline --> dropped: 宽限期结束
    online --> dropped: 收到 UnReg
    dropped --> [*]`}),e[1]||(e[1]=t("",23)),l(o,{value:`stateDiagram-v2
    [*] --> backlog: NACP 接收消息
    backlog --> ackPending: 目标在线，提交给 NACT
    ackPending --> completed: 收到 ACK
    ackPending --> backlog: 链路离线
    backlog --> failed: 逐出 / App dropped
    ackPending --> failed: 逐出 / App dropped
    completed --> [*]
    failed --> [*]`}),e[2]||(e[2]=a("p",null,[a("code",null,"BacklogTable 积压表"),i(" 保存尚未出线或等待重发的消息，"),a("code",null,"AckPendingTable确认表"),i(" 保存已经提交给 NACT、正在等待 ACK 的消息。")],-1)),e[3]||(e[3]=a("h3",{id:"notify与ackmessage",tabindex:"-1"},[i("Notify与AckMessage "),a("a",{class:"header-anchor",href:"#notify与ackmessage","aria-label":'Permalink to "Notify与AckMessage"'},"​")],-1)),e[4]||(e[4]=a("p",null,"Notify 和 Ack 不等待 ACK，也不进入 AckPendingTable：",-1)),l(o,{value:`stateDiagram-v2
    [*] --> backlog: NACP 接收消息
    backlog --> completed: 目标在线，提交给 NACT
    backlog --> waiting: 目标离线
    waiting --> completed: 重连后成功发出
    backlog --> failed: 容量拒绝 / 逐出
    waiting --> failed: 容量逐出 / App dropped
    completed --> [*]: 返回 true
    failed --> [*]: 返回 false`}),e[5]||(e[5]=t("",19))])}const P=d(r,[["render",s]]);export{g as __pageData,P as default};
