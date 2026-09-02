import{_ as t,C as i,o as n,c as d,a3 as a,E as p}from"./chunks/framework.BLaSdaBb.js";const g=JSON.parse('{"title":"NACP 可观测","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/observability.md","filePath":"transport/nacp/observability.md","lastUpdated":1788343005000}'),r={name:"transport/nacp/observability.md"};function l(o,s,h,c,k,b){const e=i("VitePressMermaid");return n(),d("div",null,[s[0]||(s[0]=a("",23)),p(e,{value:`sequenceDiagram
    participant P as Processor
    participant B as app.bus
    participant N as NACP
    P->>B: nacp:event:reqId:process
    B->>N: AutoSubscribe Listener 命中
    N-->>N: Notify 出站
    P->>B: nacp:event:reqId:response
    P-->>N: Response 出站`}),s[1]||(s[1]=a("",37))])}const y=t(r,[["render",l]]);export{g as __pageData,y as default};
