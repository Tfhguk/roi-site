#pragma once
#include <Arduino.h>
#include <atomic>
#include "hardware-config.h"
// DRV8833 dual H-bridge. Timed motion cannot detect a jam or confirm distance.
static bool motorOutputs=false,motorPwm=false;
static uint32_t moveStart=0,moveDuration=0,lastVoltageSample=0;
static std::atomic<float> measuredVoltage{0};
inline float hardwareVoltage(){return measuredVoltage.load();}
inline void hardwareStop(){if(motorOutputs)for(int pin:MOTOR_PINS){if(motorPwm)ledcWrite(pin,0);else digitalWrite(pin,LOW);}}
inline bool hardwareBegin(){
 const int expected[4]={25,26,27,12};
 for(int i=0;i<4;i++)if(MOTOR_PINS[i]!=expected[i])return false;
 for(int pin:MOTOR_PINS){pinMode(pin,OUTPUT);digitalWrite(pin,LOW);}motorOutputs=true;hardwareStop();
 if(RGB_LAYOUT!=1||RGB_PINS[0]!=2||RGB_PINS[1]!=4||RGB_PINS[2]!=19)return false;
 bool adc=BATTERY_ADC_PIN==32||BATTERY_ADC_PIN==33||BATTERY_ADC_PIN==34||BATTERY_ADC_PIN==35||BATTERY_ADC_PIN==36||BATTERY_ADC_PIN==39;
 if(!adc||!isfinite(DIVIDER_TOP_OHM)||!isfinite(DIVIDER_BOTTOM_OHM)||DIVIDER_TOP_OHM<=0||DIVIDER_BOTTOM_OHM<=0||!isfinite(BATTERY_MIN_V)||!isfinite(BATTERY_MAX_V)||BATTERY_MIN_V<=0||BATTERY_MAX_V<=BATTERY_MIN_V||BATTERY_MAX_V>10.8f)return false;
 if(!ALLOW_TIMED_MOTION||!isfinite(METRES_PER_SECOND)||!isfinite(DEGREES_PER_SECOND)||METRES_PER_SECOND<=0||DEGREES_PER_SECOND<=0||MOTOR_PWM<=0||MOTOR_PWM>255)return false;
 for(int i=0;i<2;i++)if(MOTOR_SIGN[i]!=1&&MOTOR_SIGN[i]!=-1)return false;
 if(DRIVER_FAULT_PIN>=0){const int p=DRIVER_FAULT_PIN;if(!(p==13||p==14||p==16||p==17||p==18||p==21||p==22||p==23||p==32||p==33||p==34||p==35||p==36||p==39)||p==BATTERY_ADC_PIN)return false;pinMode(p,INPUT);}
 analogReadResolution(12);analogSetPinAttenuation(BATTERY_ADC_PIN,ADC_11db);
 int attached=0;for(int pin:MOTOR_PINS){if(!ledcAttach(pin,18000,8)){for(int i=0;i<attached;i++)ledcDetach(MOTOR_PINS[i]);for(int p:MOTOR_PINS){pinMode(p,OUTPUT);digitalWrite(p,LOW);}return false;}attached++;ledcWrite(pin,0);}motorPwm=true;
 return true;
}
// 5 low battery; 8 implausible/disconnected/over-range voltage; 9 nFAULT.
inline int hardwareSelfTest(){
 if(DRIVER_FAULT_PIN>=0&&digitalRead(DRIVER_FAULT_PIN)==LOW)return 9;
 if(!lastVoltageSample||millis()-lastVoltageSample>=100){
  float mv=0;for(int i=0;i<8;i++)mv+=analogReadMilliVolts(BATTERY_ADC_PIN);mv/=8;
  measuredVoltage=mv*.001f*(DIVIDER_TOP_OHM+DIVIDER_BOTTOM_OHM)/DIVIDER_BOTTOM_OHM;
  lastVoltageSample=millis();if(!isfinite(measuredVoltage.load())||mv<50||mv>3050||measuredVoltage.load()>BATTERY_MAX_V)return 8;
 }
 return measuredVoltage.load()<BATTERY_MIN_V?5:0;
}
inline void motorDrive(int motor,int sign){int a=MOTOR_PINS[motor*2],b=MOTOR_PINS[motor*2+1];sign*=MOTOR_SIGN[motor];ledcWrite(a,sign>0?MOTOR_PWM:0);ledcWrite(b,sign<0?MOTOR_PWM:0);}
inline bool hardwareStart(const char* kind,float value){
 hardwareStop();if(!motorPwm||!isfinite(value)||value<=0||hardwareSelfTest())return false;
 bool f=!strcmp(kind,"forward"),b=!strcmp(kind,"backward"),l=!strcmp(kind,"left"),r=!strcmp(kind,"right");if(!f&&!b&&!l&&!r)return false;
 float duration=1000.f*value/((l||r)?DEGREES_PER_SECOND:METRES_PER_SECOND);if(!isfinite(duration)||duration<10||duration>12000)return false;
 moveDuration=(uint32_t)ceilf(duration);moveStart=millis();motorDrive(0,(b||l)?-1:1);motorDrive(1,(b||r)?-1:1);return true;
}
inline int hardwareTick(){if(millis()-moveStart>=moveDuration){hardwareStop();return 1;}return 0;}
