# Questions for the TT ELOCK vendor / 致TT电子锁厂家的问题

Device / 设备: TT ELOCK, ID **82637294**, firmware on display / 屏幕显示固件: **79A-EN-V146_2625** and **78A-V5.1 7AVT1**,
Airtel 4G SIM (India / 印度). Protocol we have / 我们已有协议: *JT/T808 通讯协议扩展版(完整) A13_ELOCK* (2018-05-06).

We are building our own platform that connects to the lock **directly over TCP** using the A13 protocol (the protocol
is TCP/socket, **not MQTT**). 我们正在开发自己的平台，按照A13协议通过**TCP**直接与电子锁通讯（该协议为TCP/socket，**非MQTT**）。

Priority / 优先级: **A = blocking / 阻塞**, B = important / 重要, C = useful / 有用.
A fillable version for the vendor to complete is in `docs/VENDOR_QUESTIONS.docx` (Part A). / 供厂家填写的表格见 `docs/VENDOR_QUESTIONS.docx`（Part A）。

---

## 0. About this sample lock / 关于这台样机 (mostly B)

**S1 (B).** Confirm the **LockID (device number)** of this sample. We read 82637294 on the label and screen — is that
the LockID used in the protocol? 确认这台样机的**锁号(LockID)**。标签和屏幕显示82637294，这是协议中使用的锁号吗？

**S2 (A).** The keypad password is 8 digits (`00000000`). The protocol Key field is 6 bytes (RF lock: 10 digits;
password lock: 6 ASCII digits). Is this an **RF lock or a password lock** (per Appendix 0), and how is this 8-digit
password represented in the 6-byte Key for remote commands?
键盘密码为8位（"00000000"）。协议Key字段为6字节（RF锁：10位；密码锁：6位ASCII）。按附录0，这把锁是**RF锁还是密码锁**？远程指令时这8位密码如何编码进6字节Key？

**S3 (A).** What is the **SIM card ICCID** inside the lock? (Needed to recognise the authentication code, which the
protocol says is ICCID + version.) 锁内**SIM卡ICCID**是多少？（协议规定鉴权码为ICCID+版本号，我们需要用它识别设备。）

**S4 (B).** Is this the **7B lock** or the **4G lock** model? (They use different LBS/base-station formats — 0xE1 vs 0x5D.)
这是**7B锁**还是**4G锁**型号？（两者基站信息格式不同——0xE1与0x5D。）

**S5 (B).** Confirm the exact **firmware version** of this sample and what `79A-EN-V146_2625` and `78A-V5.1 7AVT1` each
mean (main board vs communication module?). 确认样机确切**固件版本**，并说明`79A-EN-V146_2625`与`78A-V5.1 7AVT1`分别代表什么（主板与通讯模块？）。

**S6 (C).** How are **firmware updates** applied to this device (OTA over the server? SMS? cable/tool?)?
如何为该设备进行**固件升级**（通过服务器OTA？短信？数据线/工具？）？

**S7 (C).** Does the lock have any **physical debug/serial ports** for troubleshooting? 锁是否有用于排障的**物理调试/串口**？

## A. Pointing the lock to our server / 让锁连接到我们的服务器 (all A — blocking)

**A1.** Which server (IP or domain + TCP port) is lock 82637294 connected to **right now**? Is it a gps51-based platform?
锁82637294**目前**连接的服务器IP/域名和TCP端口是什么？是基于gps51的平台吗？

**A2.** How do we change the lock's server IP/domain, TCP port and APN to our own server? Please give the exact method
and command format for each option: (a) SMS command (format + SMS password), (b) Bluetooth app or BLE command,
(c) PC configuration tool / cable, (d) command from your platform (e.g. 0x8103 params 0x0013 / 0x0018 / 0x0010, or
0x8105 command 2). 如何把锁的服务器IP/域名、TCP端口和APN改成我们自己的服务器？请提供每种方式的具体方法和指令格式：
(a) 短信指令（格式及短信密码），(b) 蓝牙App或蓝牙指令，(c) 电脑配置工具/数据线，(d) 平台下发（如0x8103参数0x0013/0x0018/0x0010，或0x8105命令字2）。

**A3.** Can you (the vendor) change the server address **remotely** for us? If yes, please first tell us the current
values (so we can restore them), then set server = `<our IP>`, TCP port = `<our port>` (values sent separately).
能否由贵司**远程**帮我们修改服务器地址？如可以，请先告知当前配置（以便恢复），再设置为：服务器 `<我们的IP>`、端口 `<我们的端口>`（具体值另行提供）。

**A4.** Does the Airtel SIM need a specific **APN**, or is it detected automatically? What is the current APN setting?
Airtel SIM卡是否需要设置**APN**，还是自动识别？当前APN设置是什么？

**A5. Recovery / 应急打开:** if we seal from our platform and our remote unseal then fails, **how is the lock opened**?
(keypad with the seal key? master/emergency password? BLE app? only by the vendor?) This is a safety prerequisite
before our first remote seal. 如果我们通过平台施封后远程解封失败，**如何打开锁**？（键盘输入施封密钥？万能/应急密码？蓝牙App？只能由厂家？）这是我们首次远程施封前的安全前提。

**A6.** After we send a lock/unlock command, what **timeout** should we expect before the lock acts and replies?
我们下发施封/解封指令后，锁执行并回复的**超时时间**大约是多少？

## B. Protocol details missing from the A13 document / A13文档中缺失的协议细节

**B1 (A).** Business frame §10.1 "数据长度 (业务数据到CRC的长度)": exactly which bytes does this length byte count?
(from 0x2A to 0x23? including the 2-byte serial number? including the CRC?)
§10.1业务帧"数据长度"字节具体统计哪些字节？（从0x2A到0x23？是否包含2字节业务流水号？是否包含CRC？）

**B2 (A).** Which **CRC algorithm** is the 1-byte CRC in the business frame, over which bytes? (e.g. CRC-8/MAXIM poly
0x31, XOR, or sum?) 业务帧1字节CRC用什么算法？计算哪些字节？（如CRC-8/MAXIM多项式0x31、异或、累加和？）

**B3 (A).** Please send **one complete real hex example** of (1) a Seal 0x8900 from the platform and (2) the lock's
0x0900 operation reply (0x55), including the business serial number and CRC (the document shows "$$").
请提供一条完整真实的十六进制示例：(1) 平台下发的施封指令0x8900，(2) 锁回复的0x0900操作回复(0x55)，含业务流水号和CRC（文档中用"$$"代替）。

**B4 (A).** The lock is currently **locally sealed** (by keypad). Can the platform unseal a locally sealed lock, and
which key must be sent? 锁目前处于"本地施封"状态（键盘上锁）。平台能否解封本地施封的锁？应下发哪个密钥？

**B5 (B).** We observed over BLE that a **keypad unseal reports LockStatus 0x60** ("unsealed") and result codes 0x70
then 0x90. Is 0x60 correct for a local/keypad unseal (Appendix 3 suggests 0xBx "local unsealed")? Why does a keypad
unseal also report 0x70 "alarm released"? 我们通过蓝牙观察到**键盘解封回报锁状态0x60**（解封态）及结果码0x70、0x90。本地/键盘解封回报0x60是否正确（附录3为0xBx"本地解封态"）？为何键盘解封还回报0x70"解除报警"？

**B6 (B).** After an active upload 0x0900 (SubCmd 0x01–0x05), should the platform send the 0x61 "normal reply", or only
the JT/T808 0x8001? (§10.3 shows both "普通回复 0x61" and "中心业务回复: 无".)
锁主动上传0x0900（SubCmd 0x01–0x05）后，平台需回复0x61"普通回复"还是只回0x8001？（§10.3两者都写了）

**B7 (B).** What is the JT/T808 **terminal ID** (header BCD[6]) of this lock, and how does it relate to 82637294?
这把锁的JT808**终端ID**（消息头BCD[6]）是多少？与82637294是什么关系？

**B8 (B).** What **authentication code** will it send (0x0102)? ICCID + version? Does it need registration (0x0100) first?
锁会发送什么**鉴权码**（0x0102）？ICCID+版本号？是否需要先注册（0x0100）？

**B9 (B).** Heartbeat interval, sleep behaviour, and how to keep the lock **online (real-time mode)** — which parameters?
心跳间隔、休眠机制，以及如何让锁保持**实时在线**——需设置哪些参数？

**B10 (B).** Are all device times **GMT+8**? Can the clock be set to UTC or India time (GMT+5:30)? Is the 0x8103
parameter 0x002A time calibration required? 设备时间是否都是**GMT+8**？能否设为UTC或印度时间（GMT+5:30）？0x8103参数0x002A校时是否必须？

**B11 (B).** Is **A13** the correct protocol version for firmware 79A-EN-V146_2625 / 78A-V5.1? Is there a newer document?
固件对应的协议版本是**A13**吗？有没有更新的协议文档？

**B12 (B).** Does the connection support **TLS/encryption**, or is it plain unencrypted TCP only?
连接是否支持**TLS/加密**，还是仅明文TCP？

**B13 (B).** Are there any **known differences between the A13 document and the real hardware** for this model?
本型号是否存在**A13文档与实际硬件之间已知的差异**？

## C. Vendor platform / API (gps51 / gitee terry3/gwebmgr) / 厂家平台与API

**C1 (B).** Does your platform support **TT ELOCK seal/unseal** (not the 锁车/断电断油 relay) via the API? Which
`cmdcode`, which parameters (key?), and does the result include the lock's operation result code (0x80/0x90/0x93 …)?
贵司平台API是否支持TT电子锁**施封/解封**（非锁车/断电断油）？cmdcode是什么？参数（密钥）如何传？返回是否含锁的操作结果码（0x80/0x90/0x93等）？

**C2 (C).** API domain, account/credentials, IP whitelist and pricing for our device(s)?
API域名、账号、IP白名单及设备费用？

**C3 (C).** Does "raw message forwarding (原始报文转发)" include the 0x0900 e-lock business frames? Format and transport?
"原始报文转发"是否包含0x0900电子锁业务数据？格式和传输方式？

**C4 (C).** Does the platform keep lock status (status bits 24–31) and TT alarms (0xE7/0xE8, rod cut, etc.)?
平台是否保存锁状态（状态位24–31）及TT扩展报警（0xE7/0xE8、锁杆剪断等）？

**C5 (B).** Please provide the **BLE protocol** for this lock (service 0x0001, characteristics 0x0002/0x0003,
0xFF00/0xFF01). We want to configure and operate the lock over Bluetooth from our own interface.
请提供这把锁的**蓝牙协议**（服务0x0001，特征值0x0002/0x0003，0xFF00/0xFF01）。我们希望用自己的界面通过蓝牙配置和操作锁。

**C6 (B).** Please provide the full **SMS/text command list** for this model (Appendix 5 lists only a few TT% commands).
请提供本型号完整的**短信/文本指令列表**（附录5只列了部分TT%指令）。

## D. Certifications & support (for production) / 认证与支持（面向量产）

**D1 (C).** Does the lock (or its cellular module) hold an **India WPC-ETA** approval, or an equivalent **FCC/CE**
certification we can use to support an Indian filing? 锁（或其蜂窝模块）是否持有**印度WPC-ETA**认证，或可用于印度申报的等效**FCC/CE**认证？

**D2 (C).** Does the lock/battery have **BIS** registration (India) or an equivalent safety certificate?
锁/电池是否有**BIS**（印度）注册或等效安全认证？

**D3 (C).** Who is our **direct engineering contact** for connection issues, and how do we report a problem?
连接问题的**技术对接人**是谁？如何反馈问题？

**D4 (C).** Firmware support duration for this model, and production **lead time and pricing**?
本型号固件支持年限，以及量产**交期与报价**？

---
*India legal/compliance items (WPC-ETA, DPDP data protection, data localization, import/customs, BIS, e-Way Bill,
supply contract, pre-go-live security review) are tracked internally — see the SmartSkale "Vendor Coordination
Questions & India Legal Compliance" checklist. Only the vendor-directed certification questions are repeated above
(§D).*
