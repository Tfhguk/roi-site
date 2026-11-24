// roi-site ESP32 DevKit V1 / Arduino-ESP32 3.x / ArduinoJson 7 / Adafruit NeoPixel.
// Motors: DRV8833 AIN1=25 AIN2=26 BIN1=27 BIN2=12. RGB WS2812 D18.
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <atomic>
#include <math.h>
#include "config.h"
// TEST ONLY: bypass battery-voltage monitoring and battery fault blocking.
#define ROI_TEST_DISABLE_BATTERY_MONITOR 1
// Motor PWM is ENABLED for real locomotion:
// #define ROI_TEST_READY_ONLY 1
#include "hardware.h"
#include "indicators.h"

enum Signal { SELFTEST=2, READY=1, RUNNING=3, NETWORK=4, BATTERY_LOW=5,
  STALL=6, FAULT=7, VOLTAGE_ERROR=8, DRIVER_ERROR=9, GEOFENCE=10, MODEL_ERROR=11, POSE_LOST=12 };
std::atomic<uint32_t> lastContact{0};
std::atomic<bool> networkReady{false};
std::atomic<int> failure{0};
std::atomic<bool> recoveryApproved{false};
QueueHandle_t incoming=nullptr, outgoing=nullptr;
Preferences journal;

struct Order {
  char id[48];
  char epoch[48];
  char kind[16];
  float value;
};
struct Result { Order order; bool ok; };
String boot, epoch, completed;
bool configured=false, active=false, completedOK=false;
Order current={};
uint32_t started=0;

static void logLine(const String &message){
  Serial.printf("[%10lu ms] %s\n",(unsigned long)millis(),message.c_str());
}

void fail(int code){
  hardwareStop();
  if(!failure.load()) failure=code;
}

bool post(const String &endpoint,const String &body,String &response){
  static uint32_t lastPostLog[3]={0,0,0};
  static bool postEverOK[3]={false,false,false};
  int slot=endpoint=="telemetry"?0:(endpoint=="ack"?1:2);
  if(!String(SERVER_URL).startsWith("http://")){
    logLine("[HTTP][POST] invalid SERVER_URL (expected http://)");return false;
  }
  HTTPClient request;
  request.setConnectTimeout(1200);
  request.setTimeout(1800);
  const String url=String(SERVER_URL)+"/api/robots/"+DEVICE_ID+"/"+endpoint;
  if(!request.begin(url)){
    if(millis()-lastPostLog[slot]>2000){logLine("[HTTP][POST] "+endpoint+" begin failed");lastPostLog[slot]=millis();}
    return false;
  }
  request.addHeader("Authorization",String("Bearer ")+DEVICE_TOKEN);
  request.addHeader("Content-Type","application/json");
  const int status=request.POST(body);
  if(status==200){
    if(!postEverOK[slot] || (endpoint=="telemetry"&&millis()-lastPostLog[slot]>5000))
      logLine("[HTTP][POST] "+endpoint+" -> HTTP 200 OK");
    postEverOK[slot]=true;lastPostLog[slot]=millis();response=request.getString();
  }else if(millis()-lastPostLog[slot]>2000){
    logLine("[HTTP][POST] "+endpoint+" -> "+String(status)+" "+(status<0?request.errorToString(status):String("HTTP error")));
    lastPostLog[slot]=millis();
  }
  request.end();
  return status==200;
}

bool fetchCommand(String &response){
  static uint32_t lastGetLog=0;
  if(!String(SERVER_URL).startsWith("http://")){
    if(millis()-lastGetLog>2000){logLine("[HTTP][GET] invalid SERVER_URL (expected http://)");lastGetLog=millis();}
    return false;
  }
  String url=String(SERVER_URL)+"/api/robots/"+DEVICE_ID+"/command?boot="+boot;
  url+="&ready="+String(configured&&!failure.load()?1:0);
  url+="&error="+String(failure.load());
  HTTPClient request;
  request.setConnectTimeout(1200);
  request.setTimeout(1800);
  if(!request.begin(url)){
    if(millis()-lastGetLog>2000){logLine("[HTTP][GET] command begin failed");lastGetLog=millis();}
    return false;
  }
  request.addHeader("Authorization",String("Bearer ")+DEVICE_TOKEN);
  const int status=request.GET();
  if(status==200){
    if(millis()-lastGetLog>5000){logLine("[HTTP][GET] command -> HTTP 200 OK");lastGetLog=millis();}
    response=request.getString();
  }else if(millis()-lastGetLog>2000){
    logLine("[HTTP][GET] command -> "+String(status)+" "+(status<0?request.errorToString(status):String("HTTP error")));
    lastGetLog=millis();
  }
  request.end();
  return status==200;
}

void networking(void*){
  Result pending={};
  bool hasResult=false;
  int reportedError=0;
  uint32_t lastTelemetry=0,lastWifiLog=0;
  wl_status_t previousWifiStatus=WL_IDLE_STATUS;
  for(;;){
    const wl_status_t wifiStatus=WiFi.status();
    if(wifiStatus!=WL_CONNECTED){
      networkReady=false;
      if(wifiStatus!=previousWifiStatus || millis()-lastWifiLog>5000){
        logLine("[WIFI] not connected; status="+String((int)wifiStatus));
        previousWifiStatus=wifiStatus;lastWifiLog=millis();
      }
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }
    if(previousWifiStatus!=WL_CONNECTED){
      logLine("[WIFI] connected; IP="+WiFi.localIP().toString()+" RSSI="+String(WiFi.RSSI())+" dBm");
      previousWifiStatus=WL_CONNECTED;lastWifiLog=millis();
    }
    if(!hasResult)hasResult=xQueueReceive(outgoing,&pending,0)==pdTRUE;
    String response,body;
    JsonDocument payload;
    if(hasResult){
      payload["epoch"]=pending.order.epoch;
      payload["boot"]=boot;
      payload["id"]=pending.order.id;
      payload["status"]=pending.ok?"done":"failed";
      serializeJson(payload,body);
      if(post("ack",body,response))hasResult=false;
      payload.clear();body="";
    }
    const int fault=failure.load();
    if(fault&&fault!=reportedError){
      payload["code"]=String(fault);
      payload["detail"]="ESP32 hardware/network fault";
      serializeJson(payload,body);
      if(post("error",body,response))reportedError=fault;
      payload.clear();body="";
    }
    if(millis()-lastTelemetry>500){
      payload["boot"]=boot;
      payload["error"]=fault;
      serializeJson(payload,body);
      if(post("telemetry",body,response))lastTelemetry=millis();
      payload.clear();body="";
    }
    if(fetchCommand(response)){
      JsonDocument reply;
      if(deserializeJson(reply,response)||!reply["epoch"].is<const char*>()){
        fail(FAULT);networkReady=false;
      }else{
        const String nextEpoch=reply["epoch"].as<String>();
        if(epoch.length()&&epoch!=nextEpoch)fail(FAULT);
        epoch=nextEpoch;
        if(reply["resume"]==true)recoveryApproved=true;
        if(reply["stop"]==true || reply["hold"]==true){
          const String reason=reply["reason"]|"";
          if(reason=="GEOFENCE")fail(GEOFENCE);
          else if(reason=="MODEL_DIVERGENCE"||reason=="MODEL_REJECTED")fail(MODEL_ERROR);
          else if(reason=="POSE_STALE")fail(POSE_LOST);
          else fail(FAULT);
        }
        lastContact=millis();
        networkReady=true;
        if(!hasResult&&!failure.load()&&reply["command"].is<JsonObject>()){
          JsonObject c=reply["command"];
          const char* id=c["id"]|"";
          const char* kind=c["kind"]|"";
          const char* unit=c["unit"]|"";
          Order order={};
          if(!strlen(id)||strlen(id)>=sizeof(order.id)||strlen(kind)>=sizeof(order.kind))fail(FAULT);
          else{
            strlcpy(order.id,id,sizeof(order.id));
            strlcpy(order.epoch,epoch.c_str(),sizeof(order.epoch));
            strlcpy(order.kind,kind,sizeof(order.kind));
            order.value=c["value"].as<float>();
            const bool turn=!strcmp(kind,"left")||!strcmp(kind,"right");
            const bool straight=!strcmp(kind,"forward")||!strcmp(kind,"backward");
            const bool stop=!strcmp(kind,"stop");
            if(!stop&&(!isfinite(order.value)||order.value<=0||
              (turn&&(order.value>45||strcmp(unit,"deg")))||
              (straight&&(order.value>0.25f||strcmp(unit,"m")))||(!turn&&!straight)))fail(FAULT);
            else if(!xQueueOverwrite(incoming,&order))fail(FAULT);
          }
        }
      }
    }else networkReady=false;
    vTaskDelay(pdMS_TO_TICKS(140));
  }
}

void finish(bool ok){
  hardwareStop();active=false;
  if(!journal.putBool("result_ok",ok)||!journal.putString("completed",current.id)){
    fail(FAULT);ok=false;
  }else journal.remove("active");
  completed=current.id;completedOK=ok;
  Result result={current,ok};
  if(xQueueSend(outgoing,&result,0)!=pdTRUE)fail(FAULT);
}

void setup(){
  Serial.begin(115200);
  delay(250);
  logLine("[BOOT] ROI robot firmware starting");
  logLine("[CONFIG] device="+String(DEVICE_ID)+" server="+String(SERVER_URL));
  boot=String((uint32_t)esp_random(),HEX)+String((uint32_t)esp_random(),HEX);
  indicatorsBegin();indicate(SELFTEST);
  if(!journal.begin("roi_robot",false))fail(FAULT);
  completed=journal.getString("completed","");
  completedOK=journal.getBool("result_ok",false);
  if(journal.getString("active","").length())fail(FAULT);
  configured=hardwareBegin();hardwareStop();
  logLine(String("[HARDWARE] initialization ")+(configured?"OK":"FAILED"));
  if(!configured){fail(FAULT);logLine("[SAFETY] hardware setup failed; motor output remains disabled");}
  incoming=xQueueCreate(1,sizeof(Order));outgoing=xQueueCreate(4,sizeof(Result));
  if(!incoming||!outgoing){fail(FAULT);return;}
  WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(true);
  logLine("[WIFI] connecting to SSID=\""+String(WIFI_SSID)+"\"");
  WiFi.begin(WIFI_SSID,WIFI_PASSWORD);
  const BaseType_t taskResult=xTaskCreate(networking,"robot-network",8192,nullptr,1,nullptr);
  if(taskResult!=pdPASS)logLine("[FATAL] failed to start network task");
  else logLine("[BOOT] network task started; waiting for Wi-Fi and server");
}

void loop(){
  if(recoveryApproved.exchange(false) && !active && configured && !hardwareSelfTest() &&
      !journal.getString("active","").length() &&
      (failure.load()==4||failure.load()==7||failure.load()==10||failure.load()==11||failure.load()==12)){
    failure=0; journal.putInt("last_fault",0);
  }
  const int hardwareFault=hardwareSelfTest();
  if(hardwareFault)fail(hardwareFault);
  static int savedFault=0;
  if(failure.load()!=savedFault){savedFault=failure.load();journal.putInt("last_fault",savedFault);}
  if(!configured||failure.load()){
    hardwareStop();
    if(active)finish(false);
    indicate(failure.load()?failure.load():FAULT);
    delay(5);return;
  }
  if(!networkReady||millis()-lastContact.load()>850){
    if(active){finish(false);fail(NETWORK);}
    hardwareStop();indicate(NETWORK);delay(5);return;
  }
  if(!active){
    Order order={};
    if(xQueueReceive(incoming,&order,0)==pdTRUE){
      current=order;
      if(completed==order.id){
        Result r={order,completedOK};
        if(xQueueSend(outgoing,&r,0)!=pdTRUE)fail(FAULT);
      }else{
        if(!journal.putString("active",order.id)){fail(FAULT);return;}
        if(!strcmp(order.kind,"stop"))finish(true);
        else if(hardwareStart(order.kind,order.value)){
          if(failure.load()){hardwareStop();finish(false);}
          else{active=true;started=millis();}
        }
        else{finish(false);fail(FAULT);}
      }
    }
  }else{
    const int state=hardwareTick();
    if(state>0)finish(true);
    else if(state<0){finish(false);fail(STALL);}
    else if(millis()-started>12000){finish(false);fail(STALL);}
  }
  indicate(active?RUNNING:READY);
  delay(5);
}
