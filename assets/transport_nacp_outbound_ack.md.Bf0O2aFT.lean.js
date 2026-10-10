import{_ as n,C as i,o as p,c as r,a3 as o,E as d,j as s,a as e}from"./chunks/framework.BLaSdaBb.js";const g=JSON.parse('{"title":"ack","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/outbound/ack.md","filePath":"transport/nacp/outbound/ack.md","lastUpdated":1791613576000}'),l={name:"transport/nacp/outbound/ack.md"};function c(k,a,h,u,b,m){const t=i("VitePressMermaid");return p(),r("div",null,[a[0]||(a[0]=o("",8)),d(t,{value:`sequenceDiagram
    participant A as App A
    participant B as App B

    A-->>B: ACK`}),a[1]||(a[1]=s("p",null,[s("code",null,"ack()"),e(" 在本端 Provider 成功接纳该 ACK 包的全部 NACT 帧后 resolve "),s("code",null,"true"),e("，不等待对端确认。接纳失败或消息被放弃时 resolve "),s("code",null,"false"),e("；断连宽限期间可继续等待重连。")],-1)),a[2]||(a[2]=s("p",null,[e("ACK 的接收与结算见 "),s("a",{href:"/transport/nacp/inbound/on-ack"},"onAck"),e("。")],-1))])}const A=n(l,[["render",c]]);export{g as __pageData,A as default};
