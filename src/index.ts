import * as usb from 'usb'

// console.log('all devices:', usb.getDeviceList())

const BLACKMAGIC_VID = 0x1edb
const PRODUCT_IDS = [0xbe49]

const atemDevices = usb.getDeviceList().filter(dev => dev.deviceDescriptor.idVendor === BLACKMAGIC_VID && PRODUCT_IDS.indexOf(dev.deviceDescriptor.idProduct) !== -1)
console.log('atem devices:', atemDevices)

const openDevice = atemDevices[0].open()
