import{_ as n,C as r,o as i,c as p,a3 as o,E as d,j as s,a as t}from"./chunks/framework.BLaSdaBb.js";const b=JSON.parse('{"title":"unregister","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/outbound/unregister.md","filePath":"transport/nacp/outbound/unregister.md","lastUpdated":1788343005000}'),l={name:"transport/nacp/outbound/unregister.md"};function u(c,e,h,g,k,m){const a=r("VitePressMermaid");return i(),p("div",null,[e[0]||(e[0]=o("",7)),d(a,{value:`sequenceDiagram
    participant A as App A
    participant B as App B

    A->>B: Unregister
    B-->>A: ACK
    Note over B: 清理 App A 的协议状态
    B->>A: Response
    A-->>B: ACK`}),e[1]||(e[1]=s("p",null,[s("code",null,"unregister()"),t(" 等待 ACK 和唯一的 Response。")],-1)),e[2]||(e[2]=s("p",null,"收到成功 Response 后，发送方将在发送ACK后关闭对应 NACT Peer，并用ResponseMessage结算Promise。",-1)),e[3]||(e[3]=s("p",null,[t("Unregister 与物理断连不同，收到 Unregister 表示对端明确离开，可以立即清理。NACT Peer 意外断开时则进入离线宽限期，详见"),s("a",{href:"/transport/nacp/lifecycle"},"生命周期"),t("。")],-1)),e[4]||(e[4]=s("p",null,[t("接收流程见 "),s("a",{href:"/transport/nacp/inbound/on-unregister"},"onUnregister"),t("。")],-1))])}const E=n(l,[["render",u]]);export{b as __pageData,E as default};
