## ATEM usb connection

This is a prototype of controlling the atem mini over usb.
It builds on the work of [atem-connection](https://github.com/nrkno/tv-automation-atem-connection) and uses [node-usb](https://github.com/tessel/node-usb) to connect to the usb device.


### Known problems

This is an early prototype, and only barely works. The code is a mess and no attempt has been made to tidy it up or attempt to turn it into a viable library. Some code is plain copied from atem-connection and should instead be refactored.

This doesnt work well on windows, as it requires replacing the default atem driver with a generic one that libusb can use. This means that the atem can no longer be controlled via the official client. On linux this is not a problem, but it makes use impractical on windows.

Sending commands isn't working yet. Wireshark shows them to be the same, but nothing happens. Not much time was put into figuring out the problem, so it could be very simple.

