// Arduino-ESP32 3.x + ArduinoJson 7.x + Adafruit NeoPixel.
// Измерение напряжения удалено. Осталась только логика движения и связи.
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <atomic>
#include "config.h"
#include "hardware.h"
#include "indicators.h"

enum Signal { SELFTEST=2, READY=1, RUNNING=3, NETWORK=4, STALL=6, FAULT=7 };

std::atomic<uint32_t> lastContact{0};
std::atomic<bool> networkReady{false};
std::atomic<int> failure{0};
QueueHandle_t incoming, outgoing;
Preferences journal;

struct Order {
  char id[48];
  char epoch[48];
  char kind[16];
  float value;
};
struct Result { Order order; bool ok; };

String boot, epoch, completed;
bool configured = false, active = false;
bool completedOK = false;
Order current;
uint32_t started = 0;

void fail(int code) {
  hardwareStop();
  active = false;
  failure = code;
}

bool post(const String& endpoint, const String& body, String& response) {
  if (!String(SERVER_URL).startsWith("http://")) return false;
  HTTPClient http;
  http.setConnectTimeout(400);
  http.setTimeout(500);
  if (!http.begin(String(SERVER_URL) + "/api/robots/" + DEVICE_ID + "/" + endpoint)) return false;
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  int status = http.POST(body);
  response = http.getString();
  http.end();
  return status == 200;
}

void networking(void*) {
  Result pendingResult;
  bool hasResult = false;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      networkReady = false;
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }
    if (!hasResult) hasResult = xQueueReceive(outgoing, &pendingResult, 0) == pdTRUE;

    String response, body;
    JsonDocument payload;

    if (hasResult) {
      payload["epoch"] = pendingResult.order.epoch;
      payload["boot"] = boot;
      payload["id"] = pendingResult.order.id;
      payload["status"] = pendingResult.ok ? "done" : "failed";
      serializeJson(payload, body);
      if (post("ack", body, response)) hasResult = false;
    }

    payload.clear();
    body = "";
    payload["boot"] = boot;
    payload["ready"] = configured && !failure.load() && !hasResult;
    payload["error"] = failure.load();
    payload["adapter_configured"] = configured;
    payload["motion_feedback"] = "calibrated_time_not_encoders";
    serializeJson(payload, body);

    if (post("poll", body, response)) {
      JsonDocument reply;
      if (deserializeJson(reply, response) || !reply["epoch"].is<const char*>()) {
        networkReady = false;
        failure = FAULT;
      } else {
        String nextEpoch = reply["epoch"].as<String>();
        if (epoch.length() && epoch != nextEpoch) failure = FAULT;
        epoch = nextEpoch;
        if (reply["stop"] == true) failure = FAULT;
        lastContact = millis();
        networkReady = true;

        if (!hasResult && reply["command"].is<JsonObject>()) {
          JsonObject c = reply["command"];
          const char* id = c["id"] | "";
          const char* kind = c["kind"] | "";
          if (!strlen(id) || strlen(id) >= 48 || strlen(kind) >= 16 || !c["value"].is<float>()) {
            failure = FAULT;
          } else {
            Order order = {};
            strlcpy(order.id, id, sizeof(order.id));
            strlcpy(order.epoch, epoch.c_str(), sizeof(order.epoch));
            strlcpy(order.kind, kind, sizeof(order.kind));
            order.value = c["value"];
            const char* unit = c["unit"] | "";
            bool turn = !strcmp(kind, "left") || !strcmp(kind, "right");
            bool move = !strcmp(kind, "forward") || !strcmp(kind, "backward");
            bool stop = !strcmp(kind, "stop");
            if (!stop && (!isfinite(order.value) || order.value <= 0 ||
                (turn && (order.value > 45 || strcmp(unit, "deg"))) ||
                (move && (order.value > .25 || strcmp(unit, "m"))) ||
                (!turn && !move))) failure = FAULT;
            else xQueueOverwrite(incoming, &order);
          }
        }
      }
    } else networkReady = false;
    vTaskDelay(pdMS_TO_TICKS(200));
  }
}

void finish(bool ok) {
  hardwareStop();
  active = false;
  if (!journal.putBool("result_ok", ok) || !journal.putString("completed", current.id)) {
    failure = FAULT;
    ok = false;
  } else journal.remove("active");
  completed = current.id;
  completedOK = ok;
  Result r = {current, ok};
  if (xQueueSend(outgoing, &r, 0) != pdTRUE) failure = FAULT;
}

void setup() {
  Serial.begin(115200);
  boot = String((uint32_t)esp_random(), HEX) + String((uint32_t)esp_random(), HEX);

  indicatorsBegin();
  indicate(SELFTEST);

  if (!journal.begin("roi_robot", false)) failure = FAULT;
  completed = journal.getString("completed", "");
  completedOK = journal.getBool("result_ok", false);
  if (journal.getString("active", "").length()) failure = FAULT;

  configured = hardwareBegin();
  hardwareStop();
  if (!configured) failure = FAULT;

  incoming = xQueueCreate(1, sizeof(Order));
  outgoing = xQueueCreate(4, sizeof(Result));
  if (!incoming || !outgoing) {
    failure = FAULT;
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  xTaskCreate(networking, "robot-network", 8192, nullptr, 1, nullptr);
}

void loop() {
  if (!configured || failure.load()) {
    hardwareStop();
    if (active) finish(false);
    indicate(failure.load() ? failure.load() : FAULT);
    delay(5);
    return;
  }

  int fault = hardwareSelfTest();
  if (fault) {
    if (active) finish(false);
    fail(fault);
    return;
  }

  if (!networkReady || millis() - lastContact > 1500) {
    if (active) {
      finish(false);
      fail(NETWORK);
    }
    hardwareStop();
    indicate(NETWORK);
    delay(5);
    return;
  }

  if (!active) {
    Order order;
    if (xQueueReceive(incoming, &order, 0) == pdTRUE) {
      current = order;
      if (completed == order.id) {
        Result r = {order, completedOK};
        if (xQueueSend(outgoing, &r, 0) != pdTRUE) fail(FAULT);
      } else {
        if (!journal.putString("active", order.id)) {
          fail(FAULT);
          return;
        }
        if (!strcmp(order.kind, "stop")) finish(true);
        else if (hardwareStart(order.kind, order.value)) {
          active = true;
          started = millis();
        } else {
          finish(false);
          fail(FAULT);
        }
      }
    }
  } else {
    int status = hardwareTick();
    if (status > 0) finish(true);
    else if (status < 0) {
      finish(false);
      fail(STALL);
    } else if (millis() - started > 12000) {
      finish(false);
      fail(STALL);
    }
  }
  indicate(active ? RUNNING : READY);
  delay(5);
}