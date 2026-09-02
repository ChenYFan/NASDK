import{_ as n,C as d,o as i,c as o,a3 as r,E as p,j as e,a as t}from"./chunks/framework.BLaSdaBb.js";const E=JSON.parse('{"title":"signal","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/outbound/signal.md","filePath":"transport/nacp/outbound/signal.md","lastUpdated":1788343005000}'),l={name:"transport/nacp/outbound/signal.md"};function c(h,a,u,k,b,g){const s=d("VitePressMermaid");return i(),o("div",null,[a[0]||(a[0]=r("",9)),p(s,{value:`sequenceDiagram
    participant A as App A
    participant B as App B

    A->>B: Signal
    B-->>A: ACK`}),a[1]||(a[1]=e("p",null,[t("App A 发送"),e("code",null,"NACP.signal()"),t("后需要等待对方ACK信号，才会结算Promise。")],-1)),a[2]||(a[2]=e("p",null,[t("NApp 的调用方式见 "),e("a",{href:"/napp/abilities/request"},[e("code",null,"request()")]),t("，接收流程可见 "),e("a",{href:"/transport/nacp/inbound/on-request"},"onRequest"),t("。")],-1))])}const y=n(l,[["render",c]]);export{E as __pageData,y as default};
