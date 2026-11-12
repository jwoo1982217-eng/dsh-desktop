/**
 * Browser half of dsh-meow-constellation.
 *
 * Adds a small capsule launcher to the DSH Web GUI. Clicking it opens the star map
 * (served by the host half) in a same-origin iframe overlay; nothing here
 * touches the DOM outside a shadow root, and no DSH service is required.
 */
window.__ModuleLoader__.load({
  id: 'dsh-meow-constellation',
  factory: (require) => {
    var module = { exports: {} }
    var inject = []

    var HOST_ID = 'dsh-meow-constellation-host'
    var APP = '/meow-constellation/app'
    var CSS = [
      ':host{all:initial}',
      '.orb{position:fixed;right:26px;bottom:92px;height:36px;padding:0 13px;border-radius:12px;',
      'background:rgba(18,26,58,.94);border:1px solid rgba(150,175,255,.34);',
      'box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 18px rgba(120,150,255,.18);',
      'color:#cdd8ff;font:13px/1 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;letter-spacing:2px;',
      'display:flex;align-items:center;gap:7px;white-space:nowrap;cursor:pointer;z-index:2147483000;',
      'user-select:none;transition:transform .25s,border-color .25s,box-shadow .25s}',
      '.orb i{font-style:normal;color:#ffd9a0;font-size:15px;letter-spacing:0}',
      '.orb:hover{transform:translateY(-3px);border-color:rgba(170,195,255,.6);box-shadow:0 10px 26px rgba(0,0,0,.55),0 0 24px rgba(140,170,255,.3)}',
      '.orb.on{border-color:rgba(255,208,138,.6);box-shadow:0 8px 24px rgba(0,0,0,.5),0 0 22px rgba(255,200,130,.22)}',
      '.overlay{position:fixed;inset:0;z-index:2147483100;background:rgba(4,6,14,.98);display:flex;flex-direction:column;padding:14px 18px 18px;box-sizing:border-box}',
      '.overlay[hidden]{display:none}',
      '.bar{display:flex;align-items:center;gap:14px;height:44px;flex:0 0 44px;color:#e8ecff;font:14px/1 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;letter-spacing:2px}',
      '.bar .title{font-size:18px;font-weight:600;text-shadow:0 0 18px rgba(140,170,255,.6)}',
      '.bar .spacer{flex:1}',
      '.bar button{background:rgba(255,255,255,.07);color:#cdd8ff;border:1px solid rgba(150,175,255,.28);',
      'border-radius:9px;padding:7px 14px;cursor:pointer;font:inherit;letter-spacing:1px}',
      '.bar button:hover{background:rgba(140,170,255,.18);color:#fff}',
      '.bar .close{font-size:18px;padding:4px 12px}',
      'iframe{flex:1;width:100%;border:1px solid rgba(150,175,255,.22);border-radius:14px;background:#05070f}',
    ].join('')

    function apply(ctx) {
      if (document.getElementById(HOST_ID)) return () => {}

      var host = document.createElement('div')
      host.id = HOST_ID
      var root = host.attachShadow({ mode: 'open' })
      root.innerHTML = '<style>' + CSS + '</style>'
        + '<button class="orb" title="记忆星图（Alt+M）"><i>✦</i>星图</button>'
        + '<div class="overlay" hidden>'
        + '<div class="bar"><span class="title">✦ 记忆星图</span>'
        + '<span class="spacer"></span>'
        + '<button class="refresh">刷新</button>'
        + '<button class="popout">新窗口</button>'
        + '<button class="close" title="关闭（Esc）">×</button></div>'
        + '<iframe allow="clipboard-write" title="记忆星图"></iframe></div>'

      document.body.appendChild(host)

      var orb = root.querySelector('.orb')
      var overlay = root.querySelector('.overlay')
      var frame = root.querySelector('iframe')
      var refresh = root.querySelector('.refresh')
      var popout = root.querySelector('.popout')
      var close = root.querySelector('.close')

      function show() {
        overlay.removeAttribute('hidden')
        frame.src = APP + '?t=' + Date.now()
        orb.classList.add('on')
      }
      function hide() {
        overlay.setAttribute('hidden', '')
        frame.src = 'about:blank'
        orb.classList.remove('on')
      }
      function toggle() {
        if (overlay.hasAttribute('hidden')) show()
        else hide()
      }
      function onKey(e) {
        if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); toggle() }
        else if (e.key === 'Escape' && !overlay.hasAttribute('hidden')) hide()
      }

      orb.addEventListener('click', toggle)
      close.addEventListener('click', hide)
      refresh.addEventListener('click', function () { frame.src = APP + '?t=' + Date.now() })
      popout.addEventListener('click', function () { window.open(APP, '_blank', 'width=1440,height=900') })
      window.addEventListener('keydown', onKey)

      return function () {
        window.removeEventListener('keydown', onKey)
        host.remove()
      }
    }

    var client_exports = {}
    Object.defineProperty(client_exports, '__esModule', { value: true })
    Object.defineProperty(client_exports, 'apply', { enumerable: true, get: function () { return apply } })
    Object.defineProperty(client_exports, 'inject', { enumerable: true, get: function () { return inject } })
    module.exports = client_exports
    return module.exports
  },
})
