import{_ as e,C as n,o as p,c as t,j as i,a as l,E as h,a3 as d}from"./chunks/framework.BLaSdaBb.js";const m=JSON.parse('{"title":"NApp 生命周期","description":"","frontmatter":{},"headers":[],"relativePath":"napp/advanced/lifecycle.md","filePath":"napp/advanced/lifecycle.md","lastUpdated":1788343005000}'),r={name:"napp/advanced/lifecycle.md"};function k(c,s,o,E,g,u){const a=n("VitePressMermaid");return p(),t("div",null,[s[0]||(s[0]=i("h1",{id:"napp-生命周期",tabindex:"-1"},[l("NApp 生命周期 "),i("a",{class:"header-anchor",href:"#napp-生命周期","aria-label":'Permalink to "NApp 生命周期"'},"​")],-1)),h(a,{value:`stateDiagram-v2
  direction LR

  state "NApp A" as AppA {
    direction TB
    [*] --> A·Created: new NApp()
    A·Created --> A·Running: start()
    A·Running --> A·Terminated: terminate()
    A·Terminated --> [*]
  }

  state "NApp B" as AppB {
    direction TB
    [*] --> B·Created: new NApp()
    B·Created --> B·Running: start()
    B·Running --> B·Terminated: terminate()
    B·Terminated --> [*]
  }

  AppA --> AppB: connect / disconnect`}),s[1]||(s[1]=d("",31))])}const y=e(r,[["render",k]]);export{m as __pageData,y as default};
