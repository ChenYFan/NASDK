import{_ as r,C as o,o as s,c as p,j as t,a,E as d}from"./chunks/framework.BLaSdaBb.js";const c=JSON.parse('{"title":"传输与协议","description":"","frontmatter":{},"headers":[],"relativePath":"transport/index.md","filePath":"transport/index.md","lastUpdated":1788343005000}'),i={name:"transport/index.md"};function l(N,e,A,m,C,f){const n=o("VitePressMermaid");return s(),p("div",null,[e[0]||(e[0]=t("h1",{id:"传输与协议",tabindex:"-1"},[a("传输与协议 "),t("a",{class:"header-anchor",href:"#传输与协议","aria-label":'Permalink to "传输与协议"'},"​")],-1)),e[1]||(e[1]=t("p",null,"NASDK 将 NApp 之间的通信分为 NACP 和 NACT 两层。",-1)),d(n,{value:`flowchart TB
    NApp["NApp<br/>应用与开发者接口"]
    NACP["NACP<br/>协议、路由与通信状态"]
    NACT["NACT<br/>连接、编解码与字节传输"]

    NApp <--> NACP
    NACP <--> NACT`}),e[2]||(e[2]=t("p",null,[t("a",{href:"./nacp"},"NACP"),a(" 是协议层，负责定义 NApp 之间如何通信，包括注册、请求、响应、订阅、通知、信号、确认与路由。")],-1)),e[3]||(e[3]=t("p",null,[t("a",{href:"./nact"},"NACT"),a(" 是传输层，负责建立和维护物理连接，并统一 WebSocket、TCP 与 Unix Socket 的收发、编解码、分片和重组。")],-1))])}const x=r(i,[["render",l]]);export{c as __pageData,x as default};
