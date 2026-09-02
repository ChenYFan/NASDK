import{_ as l,C as r,o,c,j as a,a as n,E as s,a3 as t}from"./chunks/framework.BLaSdaBb.js";const A=JSON.parse('{"title":"NACT 生命周期","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nact/lifecycle.md","filePath":"transport/nact/lifecycle.md","lastUpdated":1788343005000}'),p={name:"transport/nact/lifecycle.md"};function d(h,e,k,P,T,u){const i=r("VitePressMermaid");return o(),c("div",null,[e[0]||(e[0]=a("h1",{id:"nact-生命周期",tabindex:"-1"},[n("NACT 生命周期 "),a("a",{class:"header-anchor",href:"#nact-生命周期","aria-label":'Permalink to "NACT 生命周期"'},"​")],-1)),e[1]||(e[1]=a("p",null,[n("NACT 生命周期分为"),a("code",null,"监听入口生命周期"),n("与"),a("code",null,"Peer 生命周期"),n("。")],-1)),e[2]||(e[2]=a("p",null,"监听入口负责接收新连接，Peer 负责持有一条物理连接。NACT 不维护 App ID，也没有 NACP 的重连宽限状态。",-1)),e[3]||(e[3]=a("h2",{id:"监听入口生命周期",tabindex:"-1"},[n("监听入口生命周期 "),a("a",{class:"header-anchor",href:"#监听入口生命周期","aria-label":'Permalink to "监听入口生命周期"'},"​")],-1)),s(i,{value:`stateDiagram-v2
    [*] --> listening: listen(spec)
    listening --> closed: ServerHandle.close()
    listening --> closed: nact.terminate()
    closed --> [*]`}),e[4]||(e[4]=t("",5)),s(i,{value:`stateDiagram-v2
    [*] --> connecting: dial()
    connecting --> active: 物理连接建立
    connecting --> failed: 拨号失败
    active --> closed: 主动关闭
    active --> closed: 对端断开
    active --> closed: 出现错误
    closed --> [*]
    failed --> [*]`}),e[5]||(e[5]=t("",11)),s(i,{value:`sequenceDiagram
    participant T as NACT
    participant B as app.bus
    participant P as NACP

    T->>T: Peer 移出 peerTable
    T->>B: nact:peer:disconnect(peerId)
    B->>P: Peer 断开
    P->>P: 对应 App 进入 offline`}),e[6]||(e[6]=t("",6))])}const m=l(p,[["render",d]]);export{A as __pageData,m as default};
