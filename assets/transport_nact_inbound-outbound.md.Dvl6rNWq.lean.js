import{_ as t,C as p,o as l,c as r,j as a,a as d,E as e,a3 as n}from"./chunks/framework.BLaSdaBb.js";const y=JSON.parse('{"title":"入站与出站","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nact/inbound-outbound.md","filePath":"transport/nact/inbound-outbound.md","lastUpdated":1791613576000}'),h={name:"transport/nact/inbound-outbound.md"},k={class:"details custom-block"};function o(c,s,g,E,b,u){const i=p("VitePressMermaid");return l(),r("div",null,[s[1]||(s[1]=a("h1",{id:"入站与出站",tabindex:"-1"},[d("入站与出站 "),a("a",{class:"header-anchor",href:"#入站与出站","aria-label":'Permalink to "入站与出站"'},"​")],-1)),s[2]||(s[2]=a("p",null,"NACT 负责编码、打包与分帧NACP数据。",-1)),e(i,{value:`flowchart TD
    P[NACP] <-->|NACPMessage| T[NACT]
    T <-->|传输数据| C[NACT Transport Provider]`}),s[3]||(s[3]=n("",7)),a("details",k,[s[0]||(s[0]=a("summary",null,"出站交接流程",-1)),e(i,{value:`sequenceDiagram
    participant P as NACP
    participant T as NACT
    participant R as Transport Provider

    P->>T: sendToPeer(peerId, message)
    T->>T: 查找 Peer 并处理消息
    T->>R: 依次提交 NACT 帧
    R-->>T: 全部帧接纳完成
    T-->>P: resolve true`})]),s[4]||(s[4]=n("",4)),e(i,{value:`sequenceDiagram
    participant R as Transport Provider
    participant T as NACT
    participant P as NACP

    R->>T: 收到传输数据
    T->>T: 还原 NACPMessage
    T->>P: inbound(message, peer)`}),s[5]||(s[5]=n("",6))])}const C=t(h,[["render",o]]);export{y as __pageData,C as default};
