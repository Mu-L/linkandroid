import {BrowserWindow, screen} from "electron";

const icons = {
    success: '<svg t="1733817409678" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1488" width="1024" height="1024"><path d="M512 832c-176.448 0-320-143.552-320-320S335.552 192 512 192s320 143.552 320 320-143.552 320-320 320m0-704C300.256 128 128 300.256 128 512s172.256 384 384 384 384-172.256 384-384S723.744 128 512 128" fill="#FFF" p-id="1489"></path><path d="M619.072 429.088l-151.744 165.888-62.112-69.6a32 32 0 1 0-47.744 42.624l85.696 96a32 32 0 0 0 23.68 10.688h0.192c8.96 0 17.536-3.776 23.616-10.4l175.648-192a32 32 0 0 0-47.232-43.2" fill="#FFF" p-id="1490"></path></svg>',
    error: '<svg t="1733817396560" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1326" width="1024" height="1024"><path d="M512 128C300.8 128 128 300.8 128 512s172.8 384 384 384 384-172.8 384-384S723.2 128 512 128zM512 832c-179.2 0-320-140.8-320-320s140.8-320 320-320 320 140.8 320 320S691.2 832 512 832z" fill="#FFF" p-id="1327"></path><path d="M672 352c-12.8-12.8-32-12.8-44.8 0L512 467.2 396.8 352C384 339.2 364.8 339.2 352 352S339.2 384 352 396.8L467.2 512 352 627.2c-12.8 12.8-12.8 32 0 44.8s32 12.8 44.8 0L512 556.8l115.2 115.2c12.8 12.8 32 12.8 44.8 0s12.8-32 0-44.8L556.8 512l115.2-115.2C684.8 384 684.8 364.8 672 352z" fill="#FFF" p-id="1328"></path></svg>'
}
let win = null
let winCloseTimer = null

export const makeToast = (msg: string, options?: {
    duration?: number,
    status?: 'success' | 'error'
}) => {

    if (win) {
        win.close()
        clearTimeout(winCloseTimer)
        win = null
        winCloseTimer = null
    }

    options = Object.assign({
        status: 'error',
        duration: 0
    }, options)

    if (options.duration === 0) {
        options.duration = Math.max(msg.length * 100, 3000)
    }

    const primaryDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const width = primaryDisplay.workArea.width
    const height = 60
    const icon = icons[options.status] || icons.success

    win = new BrowserWindow({
        height,
        width,
        x: 0,
        y: 0,
        modal: true,
        frame: false,
        alwaysOnTop: true,
        // opacity: 0.9,
        center: false,
        transparent: true,
        hasShadow: false,
        show: false
    })
    const htmlContent = `
  <!DOCTYPE html>
  <html>
    <head>
      <style>
        html,body{
            height: 100vh;
            margin: 0;
            padding: 0;
            background: rgba(0, 0, 0, 0.4);
            color: #FFFFFF;
        }
        .message-view {
            height: 100vh;
            display:flex;
            text-align:center;
            padding:0 10px;
        }
        .message-view div{
            margin: auto;
            font-size: 16px;
            display: inline-block;
            line-height: 30px;
            white-space: nowrap;
        }
        .message-view div .icon{
            width: 30px;
            height: 30px;
            display:inline-block;
            margin-right: 5px;
            vertical-align: top;
        }
        ::-webkit-scrollbar {
          width: 0;
        }
      </style>
    </head>
    <body>
      <div class="message-view">
        <div id="message">${icon}${msg}</div>
      </div>
    </body>
  </html>
`;

    const encodedHTML = encodeURIComponent(htmlContent);
    win.loadURL(`data:text/html;charset=UTF-8,${encodedHTML}`);
    win.on('ready-to-show', async () => {
        const width = Math.ceil(await win.webContents.executeJavaScript(`(()=>{
            const message = document.getElementById('message');
            const width = message.scrollWidth;
            return width;
        })()`))
        win.setSize(width + 20, height)
        const x = (primaryDisplay.size.width / 2) - ((width + 20) / 2)
        const y = (primaryDisplay.size.height / 2) + 200
        win.setPosition(Math.floor(x), Math.floor(y))
        win.show()
        // win.webContents.openDevTools({
        //     mode: 'detach'
        // })
    })
    winCloseTimer = setTimeout(() => {
        win.close()
        clearTimeout(winCloseTimer)
        win = null
        winCloseTimer = null
    }, options.duration)
}