import{_ as n,C as i,o as d,c as r,a3 as p,E as o,j as e,a as t}from"./chunks/framework.BLaSdaBb.js";const q=JSON.parse('{"title":"request","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/outbound/request.md","filePath":"transport/nacp/outbound/request.md","lastUpdated":1788343005000}'),l={name:"transport/nacp/outbound/request.md"};function c(h,s,u,k,b,E){const a=i("VitePressMermaid");return d(),r("div",null,[s[0]||(s[0]=p("",8)),o(a,{value:`sequenceDiagram
    participant A as App A
    participant B as App B

    A->>B: Request
    B-->>A: ACK
    Note over B: 处理 Request
    B->>A: Response
    A-->>B: ACK`}),s[1]||(s[1]=e("p",null,[e("code",null,"NACP.request()"),t(" 默认等待唯一的最终 Response。App A 收到 Response 后会先提交 ACK，再以完整的 "),e("code",null,"ResponseMessage"),t(" 结算 Promise。")],-1)),s[2]||(s[2]=e("p",null,[t("NApp 的调用方式见 "),e("a",{href:"/napp/abilities/request"},[e("code",null,"request()")]),t("，接收流程可见 "),e("a",{href:"/transport/nacp/inbound/on-request"},"onRequest"),t("。")],-1))])}const y=n(l,[["render",c]]);export{q as __pageData,y as default};
