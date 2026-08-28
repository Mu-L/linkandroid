import {cloneDeep} from 'lodash-es'
import {defineStore} from 'pinia'
import {computed, ComputedRef, ref, toRaw} from 'vue'
import {t} from '../../lang'
import {Dialog} from '../../lib/dialog'
import {mapError} from '../../lib/error'
import {isIPWithPort} from '../../lib/linkandroid'

import {
    DeviceGroup,
    DeviceRecord,
    DeviceRuntime,
    DeviceSetting,
    EnumDeviceStatus,
    EnumDeviceType,
    ShellController,
} from '../../types/Device'
import store from '../index'
import {useSettingStore} from './setting'

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// scrcpy stderr 中命中任一关键词即视为投屏失败（避免 scrcpy 版本 banner 出现在 stdout 时静默吞掉失败）
const MIRROR_ERROR_KEYWORDS = ['error', 'failed', 'could not', 'unable', 'cannot', 'exception', 'not found']

const getEmptySetting = () => {
    return JSON.parse(
        JSON.stringify({
            dimWhenMirror: '',
            alwaysTop: '',
            mirrorSound: '',
            previewImage: '',
            videoBitRate: '',
            maxFps: '',
            scrcpyArgs: '',
            panelShow: '',
            powerSaveBlock: '',
            windowBorderless: '',
        }),
    )
}

const deviceRuntime = ref<Map<string, DeviceRuntime>>(new Map())
const setting = useSettingStore()
const previewImageDefault = setting.configGet('Device.previewImage', 'yes')

// WebSocket 客户端管理
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let wsReconnectAttempts = 0
const wsMaxReconnectAttempts = 10
const wsReconnectDelay = 3000

const deviceControllers = new Map<string, ShellController>()

// 用户主动停止的 DeviceManage（stop() 强杀进程会以非 0 退出码结束，需要与
// 意外失败区分开，避免触发自动重试）
const deviceManageStopped = new Set<string>()

// DeviceManage 启动串行队列：多台设备同时启动会并发抢占 adb reverse 端口导致
// 大部分启动失败，所以按固定间隔错峰串行启动
let deviceManageStartChain: Promise<void> = Promise.resolve()

const shouldStartDeviceManage = (record: DeviceRecord) => {
    return !window.__TEST_MODE__ && !isSeedConnectedDevice(record)
}

const createDeviceStatus = (record: DeviceRecord): ComputedRef<EnumDeviceStatus> => {
    const id = record.id
    return computed(() => {
        return deviceRuntime.value?.get(id)?.status || EnumDeviceStatus.WAIT_CONNECTING
    })
}

const getDeviceRuntime = (record: DeviceRecord): ComputedRef<DeviceRuntime> => {
    const id = record.id
    return computed(() => {
        const value = deviceRuntime.value?.get(id)
        if (value) {
            return value
        }
        deviceRuntime.value?.set(id, {
            status: EnumDeviceStatus.WAIT_CONNECTING,
            mirrorController: null,
            previewImage: record.setting?.previewImage || previewImageDefault,
        } as DeviceRuntime)
        return deviceRuntime.value?.get(id) as DeviceRuntime
    })
}

const updateDeviceRuntime = (record: DeviceRecord) => {
    const id = record.id
    const runtime = deviceRuntime.value?.get(id)
    if (!runtime) {
        return
    }
    deviceRuntime.value?.set(id, {
        ...runtime,
        previewImage: record.setting?.previewImage || previewImageDefault,
    })
}

const deleteDeviceRuntime = (record: DeviceRecord) => {
    deviceRuntime.value?.delete(record.id)
}

const isSeedConnectedDevice = (record: DeviceRecord) => {
    return record.raw?.seedConnected === true
}

// 连接 WebSocket
const connectWebSocket = async () => {
    try {
        const wsAddress = await $mapi.serve.getAddress()

        if (ws && ws.readyState === WebSocket.OPEN) {
            return
        }

        // 添加查询参数标识为 Render 客户端
        const wsUrl = `${wsAddress}/server?type=Render`
        ws = new WebSocket(wsUrl)

        ws.onopen = () => {
            console.log('WebSocket connected to server as Render client')
            wsReconnectAttempts = 0
        }

        ws.onmessage = (event) => {
            // console.log('WebSocket message received:', event.data);
            try {
                const data = JSON.parse(event.data)

                if (data.type === 'DeviceConnect') {
                    console.log('Device connected:', data.deviceId)
                    deviceStore().refresh()
                    return
                }

                if (data.type === 'DeviceDisconnect') {
                    console.log('Device disconnected:', data.deviceId)
                    deviceStore().refresh()
                    return
                }

                if (data.type === 'DevicePreview') {
                    const {deviceId, data: previewData} = data
                    const device = deviceStore().records.find((r) => r.id === deviceId)
                    if (device && previewData) {
                        deviceStore().edit(
                            device,
                            {
                                screenshot: previewData,
                            },
                            false,
                        )
                    }
                    return
                }

                if (data.type === 'DevicePanelButtonClick') {
                    handlePanelButtonClick(data.deviceId, data.data.id)
                    return
                }

                if (data.type === 'DeviceStatus') {
                    return
                }

                console.log('WebSocket message:', data)
            } catch (error) {
                console.error('WebSocket message parse error:', error)
            }
        }

        ws.onclose = () => {
            console.log('WebSocket disconnected, will retry...')
            ws = null

            // 自动重连
            if (wsReconnectAttempts < wsMaxReconnectAttempts) {
                wsReconnectAttempts++
                const delay = Math.min(wsReconnectDelay * wsReconnectAttempts, 30000) // 最长30秒
                console.log(
                    `WebSocket reconnecting in ${delay}ms (attempt ${wsReconnectAttempts}/${wsMaxReconnectAttempts})`,
                )
                wsReconnectTimer = setTimeout(() => {
                    connectWebSocket()
                }, delay)
            } else {
                console.error('WebSocket max reconnection attempts reached')
            }
        }

        ws.onerror = (error) => {
            console.error('WebSocket error:', error)
        }
    } catch (error) {
        console.error('Failed to connect WebSocket:', error)
    }
}

// 断开 WebSocket
const disconnectWebSocket = () => {
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer)
        wsReconnectTimer = null
    }
    if (ws) {
        ws.close()
        ws = null
    }
}

const handlePanelButtonClick = async (deviceId: string, buttonId: string) => {
    console.log(`Handling panel button click: device=${deviceId}, button=${buttonId}`)

    let args: string[] = []

    switch (buttonId) {
        case 'home':
            args = ['shell', 'input', 'keyevent', 'KEYCODE_HOME']
            await $mapi.adb.spawnShell(args, {}, deviceId)
            break
        case 'back':
            args = ['shell', 'input', 'keyevent', 'KEYCODE_BACK']
            await $mapi.adb.spawnShell(args, {}, deviceId)
            break
        case 'recent':
            args = ['shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH']
            await $mapi.adb.spawnShell(args, {}, deviceId)
            break
        case 'volume_up':
            args = ['shell', 'input', 'keyevent', 'KEYCODE_VOLUME_UP']
            await $mapi.adb.spawnShell(args, {}, deviceId)
            break
        case 'volume_down':
            args = ['shell', 'input', 'keyevent', 'KEYCODE_VOLUME_DOWN']
            await $mapi.adb.spawnShell(args, {}, deviceId)
            break
        case 'screenshot':
            args = ['shell', 'input', 'keyevent', 'KEYCODE_SYSRQ']
            await $mapi.adb.spawnShell(args, {}, deviceId)
            break
        case 'close':
            await stopDeviceManage(deviceId)
            break
        default:
            console.log(`Unknown button: ${buttonId}`)
            break
    }
}

// startDeviceManage 串行排队执行：多台设备同时启动会并发抢占 adb reverse 端口，
// 导致大部分 DeviceManage 启动失败（scrcpy 报 "adb reverse returned with value 1"）。
// 通过链式队列 + 固定间隔错峰启动，并在失败后自动重试。
const startDeviceManage = async (deviceId: string) => {
    const task = deviceManageStartChain
        .catch(() => {})
        .then(() => new Promise<void>((resolve) => setTimeout(resolve, 400)))
        .then(async () => {
            await doStartDeviceManage(deviceId)
        })
    deviceManageStartChain = task
    await task
}

// DeviceManage 启动失败后自动重试（设备仍保持连接且未被主动停止时）。
// 采用指数退避：3s → 6s → 12s → ... 上限 60s，避免持续高频重试
const deviceManageRetryCount = new Map<string, number>()
const scheduleDeviceManageRetry = (deviceId: string) => {
    const count = deviceManageRetryCount.get(deviceId) || 0
    const delay = Math.min(3000 * Math.pow(2, count), 60000)
    deviceManageRetryCount.set(deviceId, count + 1)
    setTimeout(() => {
        if (!deviceManageStopped.has(deviceId)) {
            const device = deviceStore().records.find((r) => r.id === deviceId)
            if (device && device.status === EnumDeviceStatus.CONNECTED) {
                startDeviceManage(deviceId)
            }
        }
    }, delay)
}

// 启动 debug_manage（管理模式：预览+无视频音频播放）
const doStartDeviceManage = async (deviceId: string) => {
    try {
        // 启动流程开始即视为需要运行，清除可能遗留的停止标记
        // （避免上次 stopDeviceManage 流程遗留的标记导致本次无法启动）
        deviceManageStopped.delete(deviceId)

        // 如果已经在运行,先停止
        if (deviceControllers.has(deviceId)) {
            await stopDeviceManage(deviceId)
            // stopDeviceManage 会打上 stopped 标记（用于避免旧进程退出触发重试），
            // 替换完成后必须清除，否则新进程异常退出时会被当成"主动停止"而不重试
            deviceManageStopped.delete(deviceId)
        }

        const wsAddress = await $mapi.serve.getAddress()

        const wsUrl = `${wsAddress}/server?type=DeviceManage&deviceId=${deviceId}`
        const controller = await $mapi.scrcpy.spawnShell(
            [
                // "-V","debug",
                '--serial',
                deviceId,
                '--linkandroid-server',
                wsUrl,
                '--linkandroid-preview-interval',
                '1000',
                '--linkandroid-preview-ratio',
                '30',
                '--no-video-playback',
                '--no-audio-playback',
                '--linkandroid-skip-taskbar',
            ],
            {
                stdout: (data: string) => {
                    window.$mapi.log.info('Render.DeviceManage.stdout', {deviceId, data})
                },
                stderr: (data: string) => {
                    window.$mapi.log.info('Render.DeviceManage.stderr', {deviceId, data})
                },
                success: (process: any) => {
                    // Windows 下 scrcpy 启动失败（adb reverse 冲突/连接失败）以
                    // exitCode=1 退出，App.spawnShell 会把它当作"成功"，这里手动
                    // 识别非 0 退出码并触发自动重试
                    const exitCode = process?.exitCode
                    window.$mapi.log.info('Render.DeviceManage.success', {deviceId, exitCode})
                    deviceControllers.delete(deviceId)
                    if (deviceManageStopped.has(deviceId)) {
                        deviceManageStopped.delete(deviceId)
                        return
                    }
                    if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
                        window.$mapi.log.error('DeviceManage exited abnormally, will retry', {
                            deviceId,
                            exitCode,
                        })
                        scheduleDeviceManageRetry(deviceId)
                    }
                },
                error: (msg: string, exitCode: number) => {
                    window.$mapi.log.error('Render.DeviceManage.error', {deviceId, msg, exitCode})
                    deviceControllers.delete(deviceId)
                    if (deviceManageStopped.has(deviceId)) {
                        deviceManageStopped.delete(deviceId)
                        return
                    }
                    scheduleDeviceManageRetry(deviceId)
                },
            },
        )
        deviceControllers.set(deviceId, controller)
        // 启动成功，重置失败重试计数
        deviceManageRetryCount.delete(deviceId)
    } catch (error) {
        window.$mapi.log.error('Failed to start debug_manage:', {deviceId, error})
        if (!deviceManageStopped.has(deviceId)) {
            scheduleDeviceManageRetry(deviceId)
        }
    }
}

const stopDeviceManage = async (deviceId: string) => {
    // 标记为主动停止，避免强杀进程后的非 0 退出码触发自动重试
    deviceManageStopped.add(deviceId)
    // 重置失败重试计数，避免后续重连后沿用旧的退避间隔
    deviceManageRetryCount.delete(deviceId)
    const controller = deviceControllers.get(deviceId)
    if (controller) {
        try {
            controller.stop()
        } catch (error) {
            console.error('Failed to stop debug_manage:', deviceId, error)
        }
        deviceControllers.delete(deviceId)
    }
}

export const deviceStore = defineStore('device', {
    state: () => ({
        records: [] as DeviceRecord[],
        groups: [] as DeviceGroup[],
    }),
    actions: {
        async init() {
            await $mapi.storage.get('device', 'records', []).then((records) => {
                records.forEach((record: DeviceRecord) => {
                    record.status = createDeviceStatus(record)
                    record.runtime = getDeviceRuntime(record)
                    record.screenshot = record.screenshot || null
                    record.setting = record.setting || getEmptySetting()
                })
                this.records = records
            })

            await this.loadGroups()

            // 连接 WebSocket
            await connectWebSocket()

            await this.refresh()
            setTimeout(async () => {
                await this.startWatch()
            }, 2000)
        },
        async startWatch() {
            await $mapi.adb.watch((type, data) => {
                // console.log('watch', type, data)
                this.refresh().then()
            })
        },
        async connectedDevices(): Promise<DeviceRecord[]> {
            const res = await $mapi.adb.devices()
            const data: DeviceRecord[] = []
            for (const d of res || []) {
                data.push({
                    id: d.id,
                    type: isIPWithPort(d.id) ? EnumDeviceType.WIFI : EnumDeviceType.USB,
                    name: d.model ? d.model.split(':')[1] : d.id,
                    raw: d,
                    status: createDeviceStatus(d),
                    runtime: getDeviceRuntime(d),
                    screenshot: d.screenshot || null,
                    setting: getEmptySetting(),
                })
            }
            return data
        },
        async refresh() {
            let connectedDevices: DeviceRecord[] = []
            try {
                connectedDevices = await this.connectedDevices()
            } catch (e) {
                if (!this.records.some((record) => isSeedConnectedDevice(record))) {
                    throw e
                }
            }
            let changed = false
            // 将新设备加入到列表中
            for (const device of connectedDevices) {
                let record = this.records.find((record) => record.id === device.id)
                if (!record) {
                    record = {
                        id: device.id,
                        type: device.type,
                        name: device.name,
                        raw: device.raw,
                        status: createDeviceStatus(device),
                        runtime: getDeviceRuntime(device),
                        screenshot: null,
                        setting: getEmptySetting(),
                    }
                    this.records.unshift(record)
                    changed = true
                }
            }
            // 设置已连接的设备状态
            const connectedDeviceIds = [
                ...connectedDevices.map((d) => d.id),
                ...this.records.filter((d) => isSeedConnectedDevice(d)).map((d) => d.id),
            ]
            for (const record of this.records) {
                const runtime = getDeviceRuntime(record)
                if (connectedDeviceIds.includes(record.id)) {
                    if (runtime.value.status !== EnumDeviceStatus.CONNECTED) {
                        runtime.value.status = EnumDeviceStatus.CONNECTED
                        changed = true

                        // 自动启动 debug_manage
                        if (shouldStartDeviceManage(record)) {
                            // 设备重新连接后清除停止标记，允许自动重启
                            deviceManageStopped.delete(record.id)
                            startDeviceManage(record.id)
                        }
                    }
                } else {
                    if (runtime.value.status !== EnumDeviceStatus.DISCONNECTED) {
                        runtime.value.status = EnumDeviceStatus.DISCONNECTED
                        changed = true

                        // 停止 debug_manage
                        stopDeviceManage(record.id)
                    }
                }
            }
            // 将已连接的设备排在前面
            this.records.sort((a, b) => {
                if (a.status === EnumDeviceStatus.CONNECTED) {
                    return -1
                }
                if (b.status === EnumDeviceStatus.CONNECTED) {
                    return 1
                }
                // 剩下的按照id排序
                if (a.id && b.id && a.id < b.id) {
                    return -1
                }
                return 0
            })
            // 更新并保存
            if (changed) {
                await this.sync()
            }
        },
        async delete(device: DeviceRecord) {
            const index = this.records.findIndex((record) => record.id === device.id)
            if (index === -1) {
                return
            }
            deleteDeviceRuntime(device)
            this.records.splice(index, 1)
            await this.sync()
        },
        async edit(device: DeviceRecord, update: Partial<DeviceRecord>, sync: boolean = true) {
            const record = this.records.find((record) => record.id === device.id)
            if (!record) {
                return
            }
            Object.assign(record, update)
            if (sync) {
                await this.sync()
            }
        },
        async updateSetting(id: string, setting: Partial<DeviceSetting>) {
            const record = this.records.find((record) => record.id === id)
            if (!record) {
                return
            }
            record.setting = Object.assign({}, record.setting, setting)
            updateDeviceRuntime(record)
            await this.sync()
        },
        async sync() {
            const savedRecords = toRaw(cloneDeep(this.records))
            savedRecords.forEach((record) => {
                record.runtime = undefined
                record.status = undefined
            })
            await $mapi.storage.set('device', 'records', savedRecords)
        },
        async doTop(index: number) {
            const record = this.records[index]
            this.records.splice(index, 1)
            this.records.unshift(record)
            await this.sync()
        },
        async doMirror(device: DeviceRecord) {
            const runtime = getDeviceRuntime(device)
            if (runtime.value.status !== EnumDeviceStatus.CONNECTED) {
                throw new Error('DeviceNotConnected')
            }
            if (runtime.value.mirrorController) {
                try {
                    runtime.value.mirrorController.stop()
                } catch (e) {}
                $mapi.power.stop()
                return
            }
            Dialog.loadingOn(t('device.mirroring'))
            const setting = {
                dimWhenMirror: await this.settingGet(device, 'dimWhenMirror', 'no'),
                alwaysTop: await this.settingGet(device, 'alwaysTop', 'no'),
                mirrorSound: await this.settingGet(device, 'mirrorSound', 'no'),
                videoBitRate: await this.settingGet(device, 'videoBitRate', '8M'),
                maxFps: await this.settingGet(device, 'maxFps', '60'),
                scrcpyArgs: await this.settingGet(device, 'scrcpyArgs', ''),
                panelShow: await this.settingGet(device, 'panelShow', 'no'),
                powerSaveBlock: await this.settingGet(device, 'powerSaveBlock', 'yes'),
                windowBorderless: await this.settingGet(device, 'windowBorderless', 'no'),
            }

            // 构建投屏参数
            const args: string[] = []
            args.push('--stay-awake')
            if ('yes' === setting.alwaysTop) {
                args.push('--always-on-top')
            }
            if ('yes' === setting.windowBorderless) {
                args.push('--window-borderless')
            }
            if ('no' === setting.mirrorSound) {
                args.push('--no-audio')
            }
            if (setting.videoBitRate) {
                args.push('--video-bit-rate', setting.videoBitRate)
            }
            if (setting.maxFps) {
                args.push('--max-fps', setting.maxFps)
            }
            if (setting.dimWhenMirror === 'yes') {
                args.push('--turn-screen-off')
            }
            if (setting.scrcpyArgs) {
                args.push(setting.scrcpyArgs)
            }

            // 添加 WebSocket 服务器和面板参数
            const wsAddress = await $mapi.serve.getAddress()
            const wsUrl = `${wsAddress}/server?type=DeviceMirror&deviceId=${device.id}`
            // args.push("-V","debug");
            args.push('--linkandroid-server', wsUrl)
            if (setting.panelShow === 'yes') {
                args.push('--linkandroid-panel-show')
            }

            let successTimer: ReturnType<typeof setTimeout> | null = null
            let successShown = false
            let unauthorized = false
            const MAX_MIRROR_LOG_LINES = 200
            const logs: string[] = []
            const pushLog = (prefix: string, data: string) => {
                logs.push(prefix + data)
                if (logs.length > MAX_MIRROR_LOG_LINES) {
                    logs.splice(0, logs.length - MAX_MIRROR_LOG_LINES)
                }
            }
            try {
                runtime.value.mirrorController = await $mapi.scrcpy.mirror(device.id, {
                    title: device.name as string,
                    args,
                    maxLogLines: MAX_MIRROR_LOG_LINES,
                    stdout: (data: string) => {
                        console.log('mirror.stdout', data)
                        $mapi.log.info('Mirror.stdout', data)
                        pushLog('[stdout] ', data)
                        if (!successTimer) {
                            successTimer = setTimeout(() => {
                                if (runtime.value.mirrorController) {
                                    successShown = true
                                    Dialog.tipSuccess(t('device.mirrorSuccess'))
                                }
                            }, 2000)
                        }
                    },
                    stderr: (data: string) => {
                        console.log('mirror.stderr', data)
                        $mapi.log.error('Mirror.stderr', data)
                        pushLog('[stderr] ', data)
                        if (/unauthorized/i.test(data)) {
                            unauthorized = true
                        }
                    },
                    success: () => {
                        console.log('mirror.success')
                        $mapi.log.info('Mirror.success', {successShown, logs})
                        runtime.value.mirrorController = null
                        $mapi.power.stop()
                        const hasMirrorError = logs.some(
                            (l) =>
                                l.startsWith('[stderr]') &&
                                MIRROR_ERROR_KEYWORDS.some((kw) => l.toLowerCase().includes(kw)),
                        )
                        // 只有当"既没成功弹起投屏"且（stderr 含错误信息 或 完全没有 stdout）时才提示失败，
                        // 避免 scrcpy 版本 banner 在 stdout 输出导致失败被静默吞掉
                        if (!successShown && (hasMirrorError || !logs.some((l) => l.startsWith('[stdout]')))) {
                            const logText = logs.map((l) => l.replace(/^\[(stdout|stderr)\] /, '')).join('\n')
                            const detail = logText ? `\n\n<pre>${escapeHtml(logText)}</pre>` : ''
                            Dialog.alertError(t('device.mirrorFailed') + (detail ? ` : ${detail}` : ''))
                        }
                    },
                    error: (msg: string, exitCode: number) => {
                        console.log('mirror.error', {msg, exitCode})
                        $mapi.log.error('Mirror.error', {msg, exitCode, logs})
                        runtime.value.mirrorController = null
                        $mapi.power.stop()
                        if (unauthorized) {
                            Dialog.alertError(t('device.mirrorUnauthorized'))
                            return
                        }
                        const logText = logs.map((l) => l.replace(/^\[(stdout|stderr)\] /, '')).join('\n')
                        const detail = logText ? `\n\n<pre>${escapeHtml(logText)}</pre>` : ''
                        Dialog.alertError(t('device.mirrorFailed') + ` : <code>${escapeHtml(msg)}</code>${detail}`)
                    },
                })
                // 根据用户设置决定是否阻止电脑休眠
                if (setting.powerSaveBlock === 'yes') {
                    $mapi.power.start('prevent-display-sleep')
                }
            } catch (error) {
                Dialog.tipError(mapError(error))
            } finally {
                Dialog.loadingOff()
            }
        },
        async settingGet(device: DeviceRecord, name: keyof DeviceSetting, defaultValue: string) {
            if (device.setting && name in device.setting) {
                if ('' !== device.setting[name] && undefined !== device.setting[name]) {
                    return device.setting[name]
                }
            }
            return await $mapi.config.get(`Device.${name}`, defaultValue)
        },
        // ─── Group management ──────────────────────────────────────────
        async loadGroups() {
            this.groups = await $mapi.storage.get('device', 'groups', [])
        },
        async syncGroups() {
            await $mapi.storage.set('device', 'groups', this.groups)
        },
        addGroup(name: string): string {
            const id = 'group_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
            this.groups.push({id, name, deviceIds: []})
            this.syncGroups()
            return id
        },
        updateGroup(id: string, update: Partial<DeviceGroup>) {
            const group = this.groups.find((g) => g.id === id)
            if (!group) return
            Object.assign(group, update)
            this.syncGroups()
        },
        deleteGroup(id: string) {
            const idx = this.groups.findIndex((g) => g.id === id)
            if (idx === -1) return
            this.groups.splice(idx, 1)
            this.syncGroups()
        },
        async setDeviceGroups(deviceId: string, groupIds: string[]) {
            for (const group of this.groups) {
                const hasDevice = group.deviceIds.includes(deviceId)
                const shouldHave = groupIds.includes(group.id)
                if (hasDevice && !shouldHave) {
                    group.deviceIds = group.deviceIds.filter((id) => id !== deviceId)
                } else if (!hasDevice && shouldHave) {
                    group.deviceIds.push(deviceId)
                }
            }
            await this.syncGroups()
        },
    },
})

const device = deviceStore(store)
device.init().then(() => {})

export const useDeviceStore = () => {
    return device
}
