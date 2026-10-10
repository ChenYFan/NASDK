import{_ as n,C as e,o as p,c as t,j as i,a as l,E as h,a3 as r}from"./chunks/framework.BLaSdaBb.js";const y=JSON.parse('{"title":"NApp 生命周期","description":"","frontmatter":{},"headers":[],"relativePath":"napp/advanced/lifecycle.md","filePath":"napp/advanced/lifecycle.md","lastUpdated":1791613576000}'),d={name:"napp/advanced/lifecycle.md"};function k(c,s,o,E,g,u){const a=e("VitePressMermaid");return p(),t("div",null,[s[0]||(s[0]=i("h1",{id:"napp-生命周期",tabindex:"-1"},[l("NApp 生命周期 "),i("a",{class:"header-anchor",href:"#napp-生命周期","aria-label":'Permalink to "NApp 生命周期"'},"​")],-1)),h(a,{value:`stateDiagram-v2
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

  AppA --> AppB: connect / disconnect`}),s[1]||(s[1]=r("",31))])}const m=n(d,[["render",k]]);export{y as __pageData,m as default};
