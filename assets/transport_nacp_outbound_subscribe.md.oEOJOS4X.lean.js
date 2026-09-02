import{_ as t,C as i,o as n,c as p,a3 as e,E as r}from"./chunks/framework.BLaSdaBb.js";const E=JSON.parse('{"title":"subscribe","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/outbound/subscribe.md","filePath":"transport/nacp/outbound/subscribe.md","lastUpdated":1788343005000}'),d={name:"transport/nacp/outbound/subscribe.md"};function o(c,s,l,b,h,u){const a=i("VitePressMermaid");return n(),p("div",null,[s[0]||(s[0]=e("",9)),r(a,{value:`sequenceDiagram
    participant A as App A
    participant B as App B

    A->>B: Subscribe
    B-->>A: ACK
    Note over B: 建立订阅
    B->>A: Response
    A-->>B: ACK`}),s[1]||(s[1]=e("",3))])}const g=t(d,[["render",o]]);export{E as __pageData,g as default};
