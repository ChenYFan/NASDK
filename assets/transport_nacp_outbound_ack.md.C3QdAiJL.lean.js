import{_ as n,C as i,o as p,c as r,a3 as d,E as o,j as s,a as e}from"./chunks/framework.BLaSdaBb.js";const g=JSON.parse('{"title":"ack","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/outbound/ack.md","filePath":"transport/nacp/outbound/ack.md","lastUpdated":1788343005000}'),l={name:"transport/nacp/outbound/ack.md"};function c(k,a,h,u,m,b){const t=i("VitePressMermaid");return p(),r("div",null,[a[0]||(a[0]=d("",8)),o(t,{value:`sequenceDiagram
    participant A as App A
    participant B as App B

    A-->>B: ACK`}),a[1]||(a[1]=s("p",null,[s("code",null,"ack()"),e(" 在 ACK 交给目标 NACT Peer 后结算Promise。")],-1)),a[2]||(a[2]=s("p",null,[e("ACK 的接收与结算见 "),s("a",{href:"/transport/nacp/inbound/on-ack"},"onAck"),e("。")],-1))])}const A=n(l,[["render",c]]);export{g as __pageData,A as default};
