import{_ as n,C as o,o as s,c as p,j as r,a as t,E as d}from"./chunks/framework.BLaSdaBb.js";const c=JSON.parse('{"title":"传输与协议","description":"","frontmatter":{},"headers":[],"relativePath":"transport/index.md","filePath":"transport/index.md","lastUpdated":1791613576000}'),i={name:"transport/index.md"};function l(N,e,A,C,m,P){const a=o("VitePressMermaid");return s(),p("div",null,[e[0]||(e[0]=r("h1",{id:"传输与协议",tabindex:"-1"},[t("传输与协议 "),r("a",{class:"header-anchor",href:"#传输与协议","aria-label":'Permalink to "传输与协议"'},"​")],-1)),e[1]||(e[1]=r("p",null,"NASDK 将 NApp 之间的通信分为 NACP 和 NACT 两层。",-1)),d(a,{value:`flowchart TB
    NApp["NApp<br/>应用与开发者接口"]
    NACP["NACP<br/>协议、路由与通信状态"]
    NACT["NACT<br/>连接、编解码与字节传输"]

    NApp <--> NACP
    NACP <--> NACT`}),e[2]||(e[2]=r("p",null,[r("a",{href:"./nacp"},"NACP"),t(" 是协议层，负责定义 NApp 之间如何通信，包括注册、请求、响应、订阅、通知、信号、确认与路由。")],-1)),e[3]||(e[3]=r("p",null,[r("a",{href:"./nact"},"NACT"),t(" 是传输层 core，负责维护 Peer、编解码、分帧与重组。物理连接由按需安装的 Transport Provider 建立；连接建立后，各 Provider 都以 NACT 帧为单位与 NACT 双向交换数据。")],-1))])}const T=n(i,[["render",l]]);export{c as __pageData,T as default};
