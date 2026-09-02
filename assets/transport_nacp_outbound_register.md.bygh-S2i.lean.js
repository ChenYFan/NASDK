import{_ as i,C as n,o as r,c as p,a3 as o,E as l,j as e,a}from"./chunks/framework.BLaSdaBb.js";const A=JSON.parse('{"title":"register","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/outbound/register.md","filePath":"transport/nacp/outbound/register.md","lastUpdated":1788343005000}'),d={name:"transport/nacp/outbound/register.md"};function c(h,s,g,k,u,b){const t=n("VitePressMermaid");return r(),p("div",null,[s[0]||(s[0]=o("",9)),l(t,{value:`sequenceDiagram
    participant A as App A
    participant B as App B

    A->>B: Register
    B-->>A: ACK
    Note over B: 校验并绑定 App A
    B->>A: Response
    A-->>B: ACK`}),s[1]||(s[1]=e("p",null,[e("code",null,"register(to, peer)"),a(" 等待 ACK 和唯一的 Response，并将校验 Response 的 "),e("code",null,"from"),a(" 是否与 "),e("code",null,"to"),a(" 一致。完全一致后才会结算Promise。")],-1)),s[2]||(s[2]=e("p",null,[a("Register Response 会对称返回对端的 "),e("code",null,"{ isGateway, decl, record? }"),a("，接收消息见 "),e("a",{href:"/transport/nacp/inbound/on-register"},"onRegister"),a("。")],-1))])}const E=i(d,[["render",c]]);export{A as __pageData,E as default};
