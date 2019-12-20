import * as usb from 'usb'
import { promisify } from 'util'
import { Atem } from './atem'
import { Commands } from 'atem-connection'

// console.log('all devices:', usb.getDeviceList())

const BLACKMAGIC_VID = 0x1edb
const PRODUCT_IDS = [0xbe49]

const atemDevices = usb.getDeviceList().filter(dev => dev.deviceDescriptor.idVendor === BLACKMAGIC_VID && PRODUCT_IDS.indexOf(dev.deviceDescriptor.idProduct) !== -1)
console.log('atem devices:', atemDevices)

;(async () => {
    const openDevice = atemDevices[0]
    openDevice.open()

    // const res = await controlTransfer(0xa1, 0x02, 0x00, 0x02, 1)
    // console.log('in', res)

    const potIface = openDevice.interfaces.filter(iface => iface.descriptor.bNumEndpoints > 0 && iface.endpoints.find(ep => ep.direction === 'in'))
    // console.log(potIface)

    // const iface = openDevice.interface(1)
    const iface = potIface[1]
    // console.log(iface)
    iface.claim()
    // console.log('iface', openDevice.interfaces)
    // const ep = iface.endpoint()
    const ep = iface.endpoints[1] as usb.InEndpoint
    // console.log('ep', ep.direction, ep.transferType)

    // ;(ep as any).clearHalt(() => {})

    const outEp = iface.endpoints[0] as usb.OutEndpoint
    // console.log('outEp', outEp.direction, outEp.transferType)


    ep.on('data', (data: Buffer)  => {
        // TODO - this gets stuck after 3 receives. Changes with the parameter to startPoll

        if (data.length > 0) {
            // const length = data.readInt16LE(0)
            // if (data.length == length + 4) {
            //     console.log('received valid looking packet')
            //     ;(atem as any).socket._parseCommands(data.slice(0))
            // } else {
            //     console.log('length mismatch', data.length, length + 4)
            //     console.log(data)
            // }
            let buf = data.slice(4)
            if (buf.readInt16LE(0) === 0) {
                // TODO - why does this happen?
                buf = buf.slice(4)
            }
            ;(atem as any).socket._parseCommands(buf)
            // console.log('received ', data.length)
        }
    })
    ep.on('error', err => {
        console.log('in error:', err)
    })
    ep.startPoll(undefined, 8 * 1024) // TODO - this is larger for official client, but there ends up with an extra 4 bytes after 8kb, which throws off parsing
    console.log('listening for data')


    console.log('starting handshake')

    const res = await new Promise((resolve, reject) => {
        openDevice.controlTransfer(0xa1, 0x02, 0x00, 0x02, 1, (err, res) => {
            if (err) reject(err)
            else resolve(res)
        })
    })
    // console.log('in1', res)

    const res2 = await new Promise((resolve, reject) => {
        openDevice.controlTransfer(0x21, 0x00, 0x00, 0x02, Buffer.alloc(0), (err, res) => {
            if (err) reject(err)
            else resolve(res)
        })
    })
    // console.log('out2', res2)
    
    const res3 = await new Promise((resolve, reject) => {
        openDevice.controlTransfer(0xa1, 0x02, 0x00, 0x02, 1, (err, res) => {
            if (err) reject(err)
            else resolve(res)
        })
    })
    // console.log('in3', res3)
    console.log('completed handshake')

    const atem = new Atem({ debug: true })
    atem.on('stateChanged', () => {
        console.log('new state')
    })
    atem.on('connected', () => {
        console.log('connected!')

        const pgCmd = new Commands.ProgramInputCommand(0, 2)
        const buf = pgCmd.serialize()
        const header = Buffer.alloc(4 + 8)
        header.writeInt16LE(buf.length + 8, 0)
        header.writeUInt16BE(buf.length + 8, 4)
		header.write('CPgi', 8, 4)

        const buf2 = Buffer.concat([
            header,
            buf
        ])
        // Note: sending a packet with a badly formed header causes the atem to crash. so be careful!

        // TODO - This appears to match the wireshark perfectly, but doesnt work
        // setInterval(() => {
        //     console.log('sending', buf2)
        //     outEp.transfer(buf2, err => {
        //         console.log(err)
        //     })
        // }, 2000)
    })
    atem.on('receivedCommands', (cmds) => {
        cmds.forEach(cmd => console.log(cmd.constructor.name))
    })

    // setTimeout(() => {
    //     // sleep to 
    // }, 5000)
    

})()


