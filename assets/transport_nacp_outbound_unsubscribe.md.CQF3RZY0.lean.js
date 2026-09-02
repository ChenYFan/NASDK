import{_ as i,C as n,o as t,c as r,a3 as e,E as p}from"./chunks/framework.BLaSdaBb.js";const g=JSON.parse('{"title":"unsubscribe","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/outbound/unsubscribe.md","filePath":"transport/nacp/outbound/unsubscribe.md","lastUpdated":1788343005000}'),o={name:"transport/nacp/outbound/unsubscribe.md"};function d(c,s,l,b,u,h){const a=n("VitePressMermaid");return t(),r("div",null,[s[0]||(s[0]=e("",8)),p(a,{value:`sequenceDiagram
    participant A as App A
    participant B as App B

    A->>B: Unsubscribe
    B-->>A: ACK
    Note over B: 移除订阅
    B->>A: Response
    A-->>B: ACK`}),s[1]||(s[1]=e("",4))])}const m=i(o,[["render",d]]);export{g as __pageData,m as default};
