#pragma once
#include <Adafruit_NeoPixel.h>
#include "hardware-config.h"
static Adafruit_NeoPixel pixel0(1,RGB_PINS[0],NEO_GRB+NEO_KHZ800),pixel1(1,RGB_PINS[1],NEO_GRB+NEO_KHZ800),pixel2(1,RGB_PINS[2],NEO_GRB+NEO_KHZ800);
static Adafruit_NeoPixel* pixels[3]={&pixel0,&pixel1,&pixel2};
inline void indicatorsBegin(){if(RGB_LAYOUT==1)for(auto p:pixels){p->begin();p->setBrightness(32);p->clear();p->show();}}
inline void indicate(int code){
 static int previous=-1;if(code==previous)return;previous=code;
 const uint32_t red=0xff0000,green=0x00ff00,blue=0x0000ff,yellow=0xffff00,cyan=0x00ffff,purple=0xff00ff;
 uint32_t c[3]={red,red,red};
 switch(code){case 0:c[0]=c[1]=c[2]=0;break;case 1:c[0]=c[1]=c[2]=green;break;case 2:c[0]=c[1]=c[2]=blue;break;case 3:c[0]=c[1]=c[2]=cyan;break;case 4:c[0]=red;c[1]=c[2]=0;break;case 5:c[0]=c[1]=red;c[2]=0;break;case 6:c[0]=red;c[1]=yellow;c[2]=0;break;case 8:c[0]=red;c[1]=purple;c[2]=0;break;case 9:c[0]=red;c[1]=yellow;c[2]=yellow;break;}
 if(RGB_LAYOUT==1)for(int i=0;i<3;i++){pixels[i]->setPixelColor(0,c[i]);pixels[i]->show();}
}
