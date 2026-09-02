import{_ as a,C as t,o as u,c,a3 as r,E as n,j as s,a as i}from"./chunks/framework.BLaSdaBb.js";const R=JSON.parse('{"title":"AutoSubscribe","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/auto-subscribe.md","filePath":"transport/nacp/auto-subscribe.md","lastUpdated":1788343005000}'),b={name:"transport/nacp/auto-subscribe.md"};function p(d,e,l,A,q,h){const o=t("VitePressMermaid");return u(),c("div",null,[e[0]||(e[0]=r("",8)),n(o,{value:`sequenceDiagram
    participant A as 请求方 App A
    participant B as 接收方 App B

    Note over A: 构造 Request，得到 reqId
    A->>B: Request
    B-->>A: ACK
    Note over B: Request 已开始处理
    B--xA: Sub建立前消息（尚未订阅，丢失）

    Note over A: 以 reqId 构造 Subscribe
    A->>B: Subscribe
    B-->>A: ACK
    Note over B: 建立过程流转发监听
    B->>A: Response
    A-->>B: ACK
    Note over A: 保存订阅 ID，开始监听

    B-->>A: 后续 0..N Notify
    Note over B: Request 处理结束
    B->>A: Response
    A-->>B: ACK

    Note over A: 构造 Unsubscribe
    A->>B: Unsubscribe
    B-->>A: ACK
    Note over B: 移除过程流转发监听
    B->>A: Response
    A-->>B: ACK
    Note over A: 移除本地接收记录`}),e[1]||(e[1]=s("p",null,"这套流水线有两个问题：",-1)),e[2]||(e[2]=s("ul",null,[s("li",null,"Request 先开始工作，Subscribe 后建立，在这段时间内产生的过程消息没有转发监听，会直接丢失。"),s("li",null,"每次 Event Request 都会额外产生一组 Subscribe / Ack / Response 和 Unsubscribe / Ack / Response 往返。")],-1)),e[3]||(e[3]=s("h2",{id:"eventrequest自动监听",tabindex:"-1"},[i("EventRequest自动监听 "),s("a",{class:"header-anchor",href:"#eventrequest自动监听","aria-label":'Permalink to "EventRequest自动监听"'},"​")],-1)),e[4]||(e[4]=s("p",null,"AutoSubscribe 将订阅的建立和清理并入 Request / Response 生命周期：",-1)),n(o,{value:`sequenceDiagram
    participant A as 请求方 App A
    participant B as 接收方 App B

    Note over A: 构造 Request，得到 reqId
    A->>A: 虚拟出站SubScribe
    A->>B: Request
    B-->>A: ACK
    B->>B: 虚拟入站SubScribe
    B-->>A: 0..N Notify
    Note over B: 提交 Response
    B->>B: 虚拟入站UnSubScribe
    B->>A: Response
    A-->>B: ACK
    A->>A: 虚拟出站UnSubScribe`}),e[5]||(e[5]=r("",20))])}const B=a(b,[["render",p]]);export{R as __pageData,B as default};
