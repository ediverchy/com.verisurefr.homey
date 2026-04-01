com.verisure.homey/
│
├── app.js
├── app.json
├── package.json
├── README.txt
├── README.fr.txt
│
├── assets/
│   ├── icon.svg                        ← icon-app.svg
│   └── images/
│       ├── small.png                   ← app-small.png
│       ├── large.png                   ← app-large.png
│       └── xlarge.png                  ← app-xlarge.png
│
├── locales/
│   ├── en.json                         ← locales.en.json
│   └── fr.json                         ← locales.fr.json
│
├── lib/
│   ├── VerisureSession.js
│   ├── VerisureClient.js
│   └── VerisurePoller.js
│
├── drivers/
│   │
│   ├── contact-sensor/
│   │   ├── assets/
│   │   │   ├── icon.svg                ← icon-contact-sensor.svg
│   │   │   └── images/
│   │   │       ├── small.png           ← contact-sensor-small.png
│   │   │       ├── large.png           ← contact-sensor-large.png
│   │   │       └── xlarge.png          ← contact-sensor-xlarge.png
│   │   ├── pair/
│   │   │   ├── start.html              ← start.html
│   │   │   └── mfa.html                ← mfa.html  ✅ nouveau
│   │   ├── driver.js                   ← contact-sensor.driver.js
│   │   └── device.js                   ← contact-sensor.device.js
│   │
│   ├── alarm-panel/
│   │   ├── assets/
│   │   │   ├── icon.svg                ← icon-alarm-panel.svg
│   │   │   └── images/
│   │   │       ├── small.png           ← alarm-panel-small.png
│   │   │       ├── large.png           ← alarm-panel-large.png
│   │   │       └── xlarge.png          ← alarm-panel-xlarge.png
│   │   ├── pair/
│   │   │   └── list_devices.html       ← alarm-panel.pair.list_devices.html
│   │   ├── driver.js                   ← alarm-panel.driver.js
│   │   └── device.js                   ← alarm-panel.device.js
│   │
│   └── pir-camera/
│       ├── assets/
│       │   ├── icon.svg                ← icon-pir-camera.svg
│       │   └── images/
│       │       ├── small.png           ← pir-camera-small.png
│       │       ├── large.png           ← pir-camera-large.png
│       │       └── xlarge.png          ← pir-camera-xlarge.png
│       ├── pair/
│       │   └── list_devices.html       ← pir-camera.pair.list_devices.html
│       ├── driver.js                   ← pir-camera.driver.js
│       └── device.js                   ← pir-camera.device.js
│
└── settings/
    └── index.html                      ← settings.index.html