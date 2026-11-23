#pragma once
#include <Adafruit_NeoPixel.h>
#include "hardware-config.h"
static Adafruit_NeoPixel strip(RGB_LED_COUNT,RGB_DATA_PIN,NEO_GRB+NEO_KHZ800);
inline void indicatorsBegin(){
  if(RGB_LAYOUT==1&&RGB_DATA_PIN==18&&RGB_LED_COUNT==12){
    strip.begin();strip.setBrightness(32);strip.clear();strip.show();
  }
}
inline void indicate(int code){
  // All emergency states have distinct pixel patterns, not color only.
  static int previous=-1;static int previousPhase=-1;
  const int phase=(millis()/350)%2;
  if(code==previous&&(code<4||phase==previousPhase))return;
  previous=code;previousPhase=phase;
  const uint32_t RED=0xff0000,GREEN=0x00ff00,BLUE=0x0000ff,YELLOW=0xffff00,CYAN=0x00ffff,PURPLE=0xff00ff;
  uint32_t c[3]={0,0,0};
  switch(code){
    case 0:break;
    case 1:c[0]=c[1]=c[2]=GREEN;break;
    case 2:c[0]=c[1]=c[2]=BLUE;break;
    case 3:c[0]=c[1]=c[2]=CYAN;break;
    case 4:c[0]=phase?RED:0;break;
    case 5:c[0]=c[1]=phase?RED:0;break;
    case 6:c[0]=RED;c[1]=phase?YELLOW:0;break;
    case 8:c[0]=RED;c[1]=phase?PURPLE:0;break;
    case 9:c[0]=RED;c[1]=c[2]=phase?YELLOW:0;break;
    case 10:c[0]=c[1]=c[2]=phase?RED:0;break; // boundary
    case 11:c[0]=phase?RED:0;c[1]=phase?0:RED;c[2]=RED;break; // model
    case 12:c[0]=PURPLE;c[1]=phase?PURPLE:0;c[2]=0;break; // pose
    default:c[0]=c[1]=c[2]=phase?RED:0;break;
  }
  if(RGB_LAYOUT==1&&RGB_DATA_PIN==18&&RGB_LED_COUNT==12){
    // Each logical indicator section occupies four consecutive physical LEDs.
    for(int i=0;i<RGB_LED_COUNT;i++)strip.setPixelColor(i,c[i/4]);
    strip.show();
  }
}
