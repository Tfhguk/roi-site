// roi-site ESP32 DevKit V1 / Arduino-ESP32 3.x / ArduinoJson 7 / Adafruit NeoPixel.
// Motors: DRV8833 AIN1=25 AIN2=26 BIN1=27 BIN2=12. RGB WS2812 D18.
// Fail closed: no motion until hardware-config.h contains real calibration and ADC divider.
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <atomic>
#include <math.h>
#include "config.h"
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

void fail(int code){
  // Force zero PWM before any network operation. Main loop records the error.
  hardwareStop();
  if(!failure.load()) failure=code;
}

bool post(const String &endpoint,const String &body,String &response){
  if(!String(SERVER_URL).startsWith("http://"))return false;
  HTTPClient request;
  request.setConnectTimeout(350);
  request.setTimeout(450);
  if(!request.begin(String(SERVER_URL)+"/api/robots/"+DEVICE_ID+"/"+endpoint))return false;
  request.addHeader("Authorization",String("Bearer ")+DEVICE_TOKEN);
  request.addHeader("Content-Type","application/json");
  const int status=request.POST(body);
  if(status==200)response=request.getString();
  request.end();
  return status==200;
}

bool fetchCommand(String &response){
  if(!String(SERVER_URL).startsWith("http://"))return false;
  String url=String(SERVER_URL)+"/api/robots/"+DEVICE_ID+"/command?boot="+boot;
  url+="&ready="+String(configured&&!failure.load()?1:0);
  url+="&error="+String(failure.load());
  url+="&battery_v="+String(hardwareVoltage(),3);
  HTTPClient request;
  request.setConnectTimeout(350);
  request.setTimeout(450);
  if(!request.begin(url))return false;
  request.addHeader("Authorization",String("Bearer ")+DEVICE_TOKEN);
  const int status=request.GET();
  if(status==200)response=request.getString();
  request.end();
  return status==200;
}

void networking(void*){
  Result pending={};
  bool hasResult=false;
  int reportedError=0;
  uint32_t lastTelemetry=0;
  for(;;){
    if(WiFi.status()!=WL_CONNECTED){
      networkReady=false;
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
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
      payload["battery_v"]=hardwareVoltage();
      serializeJson(payload,body);
      if(post("error",body,response))reportedError=fault;
      payload.clear();body="";
    }
    if(millis()-lastTelemetry>500){
      payload["boot"]=boot;
      payload["battery_v"]=hardwareVoltage();
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
  boot=String((uint32_t)esp_random(),HEX)+String((uint32_t)esp_random(),HEX);
  indicatorsBegin();indicate(SELFTEST);
  if(!journal.begin("roi_robot",false))fail(FAULT);
  completed=journal.getString("completed","");
  completedOK=journal.getBool("result_ok",false);
  if(journal.getString("active","").length())fail(FAULT);
  configured=hardwareBegin();hardwareStop();
  if(!configured)fail(FAULT);
  incoming=xQueueCreate(1,sizeof(Order));outgoing=xQueueCreate(4,sizeof(Result));
  if(!incoming||!outgoing){fail(FAULT);return;}
  WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(true);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);
  xTaskCreate(networking,"robot-network",8192,nullptr,1,nullptr);
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
  // Losing either Wi-Fi or successful GET heartbeat cuts all motor PWM.
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
          if(failure.load()){hardwareStop();finish(false);} // safety check across FreeRTOS tasks
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
