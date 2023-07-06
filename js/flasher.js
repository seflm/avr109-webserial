/*

MIT License

Copyright (c) 2021 Benjamin Aigner
Copyright (c) 2023 QVEX Tech

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

class AVR109Flasher
{
    constructor(dataToFlash, usbVid, usbPid, progressCallback=undefined)
    {
        this.dataToFlash = dataToFlash;
        this.usbVid = usbVid;
        this.usbPid = usbPid;

        if (progressCallback)
            this.progressCallback = progressCallback;
    }

    async flash()
    {
        //parse intel hex
        let flashData = AVR109Flasher.parseIntelHex(this.dataToFlash);
        
        //request serial port
        let filters = 
        [{ 
            usbVendorId: this.usbVid, usbProductId: this.usbPid }
            //TODO: I think there are more possible PIDs...
        ];
        const port = await navigator.serial.requestPort({ filters });
        
        //open & close
        // Wait for the serial port to open.
        await port.open({ baudRate: 57600 });
        
        //open writing facilities (with text encoder -> not good!)
        /*const textEncoder = new TextEncoderStream();
        const writableStreamClosed = textEncoder.readable.pipeTo(port.writable);
        const writer = textEncoder.writable.getWriter();*/

        //open writing facilities
        const writer = port.writable.getWriter();

        //open reading stream
        const reader = port.readable.getReader();
        
        //trigger update by sending programmer ID command
        await writer.write(new Uint8Array([0x53]));
        await delay(10);
        
        // Listen to data coming from the serial device.
        let state = 0;
        let pageStart = 0;
        let address = 0;
        while (true) 
        {
            
            const { value, done } = await reader.read();
            if (done) 
            {
                // Allow the serial port to be closed later.
                reader.releaseLock();
                writer.releaseLock();
                break;
            }
            
            /****************/
            // 3.) flashing the .hex file (event driven by the received data from the ATMega32U4).
            // most commands are acknowledged with 13d.
            /****************/
            if (state == 0) 
            {
                await delay(100);
                //1.) "S" => "CATERIN" - get programmer ID
                if (equals(value, [67, 65, 84, 69, 82, 73, 78])) 
                {
                    //console.log("programmer \"CATERIN\" detected, entering programming mode");
                    await writer.write(new Uint8Array([0x50]));
                    await delay(5);
                    state = 1;
                } 
                else 
                {
                    //console.log("error: unexpected RX value in state 0, waited for \"CATERIN\"");
                }
            } 
            else if (state == 1) 
            {
                //2.) "P" => 13d - enter programming mode
                if (equals(value, [13])) 
                {
                    //console.log("setting address to: " + address);
                    const data = new Uint8Array([0x41, (address >> 8) & 0xFF, address & 0xFF]); // 'A' high low
                    //console.log("O: " + data);
                    await writer.write(data);
                    await delay(5);
                    state = 2;
                } else 
                {
                    //console.log("error: unexpected RX value in state 1, waited for 13");
                }
            } 
            else if (state == 2) 
            {
                //3.) now flash page
                if (equals(value, [13])) 
                {
                    let cmd;
                    let txx;
                    let data;

                    cmd = new Uint8Array([0x42, 0x00, 0x80, 0x46]); //flash page write command ('B' + 2bytes size + 'F')

                    if (this.progressCallback)
                        this.progressCallback(Math.round(pageStart/flashData.data.length*100));
                    
                    //determine if this is the last page (maybe incomplete -> fill with 0xFF)
                    if (pageStart + 128 > flashData.data.length) 
                    {
                        data = flashData.data.slice(pageStart); //take the remaining bit
                        const pad = new Uint8Array(128 - data.length); //create a new padding array 
                        pad.fill(0xFF);
                        txx = Uint8Array.from([...cmd, ...data, ...pad]); //concat command, remaining data and padding
                        state = 3;
                    } 
                    else 
                    {
                        data = flashData.data.slice(pageStart, pageStart + 128); //take subarray with 128B
                        txx = Uint8Array.from([...cmd, ...data]); //concate command with page data
                        state = 1;
                    }
                    
                    //console.log("adress set, writing one page: " + data);
                    pageStart += 128;
                    address += 64;
                    //write control + flash data
                    await writer.write(txx);
                    //console.log("O: " + txx);
                    await delay(5);
                } 
                else 
                {
                    //console.log("error: state 2");
                }
                
            } else if (state == 3) 
            {
                //4.) last page sent, finish update
                if (value[0] == 13) 
                {
                    //console.log("Last page write, leaving programming mode");
                    //finish flashing and exit bootloader
                    await writer.write(new Uint8Array([0x4C])); //"L" -> leave programming mode
                    state = 4;
                    /*state = -1;
                    gear.classList.remove('spinning');
                    //console.log("finished!");
                    reader.cancel();*/
                } else 
                {
                    //console.log("NACK");
                }
            } 
            else if (state == 4) 
            {
                //5.) left programming mode, exiting bootloader
                if (value[0] == 13) 
                {
                    //console.log("Exiting bootloader");
                    //finish flashing and exit bootloader
                    await writer.write(new Uint8Array([0x45])); //"E" -> exit bootloader
                    state = -1;
                    //console.log("finished!");
                    reader.cancel();
                } 
                else 
                {
                    //console.log("NACK");
                }
                
            }
        }
        await port.close();
        
    }

    static parseIntelHex(data) 
    {

        const DATA = 0,
        END_OF_FILE = 1,
        EXT_SEGMENT_ADDR = 2,
        START_SEGMENT_ADDR = 3,
        EXT_LINEAR_ADDR = 4,
        START_LINEAR_ADDR = 5;
        
        const EMPTY_VALUE = 0xFF;

        //if(data instanceof Buffer)
        data = data.toString("ascii");

        //Initialization
        var buf = new Uint8Array(32768); //max. words in mega32u4 
        var bufLength = 0, //Length of data in the buffer
        highAddress = 0, //upper address
        startSegmentAddress = null,
        startLinearAddress = null,
        lineNum = 0, //Line number in the Intel Hex string
        pos = 0; //Current position in the Intel Hex string
        const SMALLEST_LINE = 11;

        while (pos + SMALLEST_LINE <= data.length) 
        {
            //Parse an entire line
            if (data.charAt(pos++) != ":")
                throw new Error("Line " + (lineNum + 1) +" does not start with a colon (:).");
            else
                lineNum++;

            //Number of bytes (hex digit pairs) in the data field
            var dataLength = parseInt(data.substr(pos, 2), 16);
            pos += 2;

            //Get 16-bit address (big-endian)
            var lowAddress = parseInt(data.substr(pos, 4), 16);
            pos += 4;

            //Record type
            var recordType = parseInt(data.substr(pos, 2), 16);
            pos += 2;

            //Data field (hex-encoded string)
            var dataField = data.substr(pos, dataLength * 2);

            if (dataLength)
                var dataFieldBuf = fromHexString(dataField);
            else 
                var dataFieldBuf = new Uint8Array();
            
            pos += dataLength * 2;

            //Checksum
            var checksum = parseInt(data.substr(pos, 2), 16);
            pos += 2;

            //Validate checksum
            var calcChecksum = (dataLength + (lowAddress >> 8) +
            lowAddress + recordType) & 0xFF;

            for (var i = 0; i < dataLength; i++)
                calcChecksum = (calcChecksum + dataFieldBuf[i]) & 0xFF;
            
            calcChecksum = (0x100 - calcChecksum) & 0xFF;

            if (checksum != calcChecksum)
                throw new Error("Invalid checksum on line " + lineNum +": got " + checksum + ", but expected " + calcChecksum);

            //Parse the record based on its recordType
            switch (recordType) {
                case DATA:
                    var absoluteAddress = highAddress + lowAddress;

                    //Expand buf, if necessary
                    /*if(absoluteAddress + dataLength >= buf.length)
                    {
                        var tmp = Buffer.alloc((absoluteAddress + dataLength) * 2);
                        buf.copy(tmp, 0, 0, bufLength);
                        buf = tmp;
                    }*/

                    //Write over skipped bytes with EMPTY_VALUE
                    if (absoluteAddress > bufLength)
                    buf.fill(EMPTY_VALUE, bufLength, absoluteAddress);

                    //Write the dataFieldBuf to buf
                    //dataFieldBuf.copy(buf, absoluteAddress);
                    dataFieldBuf.forEach(function (val, index) 
                    {
                        buf[absoluteAddress + index] = val;
                    });
                    bufLength = Math.max(bufLength, absoluteAddress + dataLength);
                    break;

                case END_OF_FILE:

                    if (dataLength != 0)
                        throw new Error("Invalid EOF record on line " +lineNum + ".");

                    return {
                        "data": buf.slice(0, bufLength),
                        "startSegmentAddress": startSegmentAddress,
                        "startLinearAddress": startLinearAddress
                    };
                    break;

                case EXT_SEGMENT_ADDR:

                    if (dataLength != 2 || lowAddress != 0)
                        throw new Error("Invalid extended segment address record on line " +lineNum + ".");

                    highAddress = parseInt(dataField, 16) << 4;
                    break;

                case START_SEGMENT_ADDR:

                    if (dataLength != 4 || lowAddress != 0)
                        throw new Error("Invalid start segment address record on line " +lineNum + ".");

                    startSegmentAddress = parseInt(dataField, 16);
                    break;

                case EXT_LINEAR_ADDR:

                    if (dataLength != 2 || lowAddress != 0)
                        throw new Error("Invalid extended linear address record on line " + lineNum + ".");

                    highAddress = parseInt(dataField, 16) << 16;
                    break;

                case START_LINEAR_ADDR:

                    if (dataLength != 4 || lowAddress != 0)
                        throw new Error("Invalid start linear address record on line " +lineNum + ".");

                    startLinearAddress = parseInt(dataField, 16);
                    break;

                default:
                    throw new Error("Invalid record type (" + recordType +") on line " + lineNum);
                    break;
            }
            //Advance to the next line
            if (data.charAt(pos) == "\r")
                pos++;
            if (data.charAt(pos) == "\n")
                pos++;
        }
        throw new Error("Unexpected end of input: missing or invalid EOF record.");
    };
}


//credits: https://www.geeksforgeeks.org/how-to-delay-a-loop-in-javascript-using-async-await-with-promise/
function delay(milisec)
{
    return new Promise(resolve =>
    {
        setTimeout(() => { resolve('') }, milisec);
    })
}

//credits: https://www.30secondsofcode.org/articles/s/javascript-array-comparison
const equals = (a, b) =>
a.length === b.length &&
a.every((v, i) => v === b[i]);

const fromHexString = hexString =>
new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
