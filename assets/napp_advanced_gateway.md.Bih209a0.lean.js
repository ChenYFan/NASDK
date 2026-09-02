import{_ as n,C as p,o as e,c as t,j as a,a as l,E as h,a3 as k}from"./chunks/framework.BLaSdaBb.js";const b=JSON.parse('{"title":"NApp as Gateway","description":"","frontmatter":{},"headers":[],"relativePath":"napp/advanced/gateway.md","filePath":"napp/advanced/gateway.md","lastUpdated":1788343005000}'),r={name:"napp/advanced/gateway.md"};function d(o,s,c,E,y,u){const i=p("VitePressMermaid");return e(),t("div",null,[s[0]||(s[0]=a("h1",{id:"napp-as-gateway",tabindex:"-1"},[l("NApp as Gateway "),a("a",{class:"header-anchor",href:"#napp-as-gateway","aria-label":'Permalink to "NApp as Gateway"'},"​")],-1)),s[1]||(s[1]=a("p",null,"一个NApp可以通过声明自己是Gateway来转发消息。",-1)),s[2]||(s[2]=a("p",null,"普通NApp可以通过Gateway NApp和另一个NApp通讯，不需要在两者之间构建直接连接。",-1)),h(i,{value:`flowchart LR

    A["NApp A"]
    G["Gateway NApp"]
    B["NApp B"]
    A -- "from A to B" --> G
    A -. "逻辑 from A to B" .-> B
    G -- "from A to B" --> B
    B -- "from B to A" --> G
    G -- "from B to A" --> A
    B -. "逻辑 from B to A" .-> A`}),s[3]||(s[3]=k("",32))])}const m=n(r,[["render",d]]);export{b as __pageData,m as default};
