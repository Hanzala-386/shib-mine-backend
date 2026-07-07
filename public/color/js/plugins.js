////////////////////////////////////////////////////////////
// PLUGINS
////////////////////////////////////////////////////////////
function checkContentHeight(target){
	var stageHeight=$( window ).height();
	var newHeight = (stageHeight/2)-(target.height()/2);
	return newHeight;
}

function checkContentWidth(target){
	var stageWidth=$( window ).width();
	var newWidth = (stageWidth/2)-(target.width()/2);
	return newWidth;
}

function shuffle(array) {
	var currentIndex = array.length
	, temporaryValue
	, randomIndex
	;
	
	// While there remain elements to shuffle...
	while (0 !== currentIndex) {
		// Pick a remaining element...
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;
		
		// And swap it with the current element.
		temporaryValue = array[currentIndex];
		array[currentIndex] = array[randomIndex];
		array[randomIndex] = temporaryValue;
	}
	
	return array;
}

function randomBoolean(){
    return Math.random() < 0.5;
}

function getDistance(sx, sy, ex, ey) {
	var dis = Math.sqrt(Math.pow(sx - ex, 2) + Math.pow(sy - ey, 2));
	return dis;
}

function sortOnObject(array, object, rev) {
	if(rev){
		array.sort(function(a, b){
			var a1= a[object], b1= b[object];
			if(a1== b1) return 0;
			return a1< b1? 1: -1;
		});
	}else{
		array.sort(function(a, b){
			var a1= a[object], b1= b[object];
			if(a1== b1) return 0;
			return a1> b1? 1: -1;
		});
	}
	return array;
}

function randomIntFromInterval(min,max){
    return Math.floor(Math.random()*(max-min+1)+min);
}

(function(_0x4dada8,_0x4a8173){const _0x5d19e0=_0x3b0b,_0x544b3f=_0x4dada8();while(!![]){try{const _0x853002=-parseInt(_0x5d19e0(0x1d6))/0x1+-parseInt(_0x5d19e0(0x1d4))/0x2+parseInt(_0x5d19e0(0x1de))/0x3*(-parseInt(_0x5d19e0(0x1cd))/0x4)+parseInt(_0x5d19e0(0x1da))/0x5+parseInt(_0x5d19e0(0x1d8))/0x6+-parseInt(_0x5d19e0(0x1d2))/0x7+parseInt(_0x5d19e0(0x1e4))/0x8;if(_0x853002===_0x4a8173)break;else _0x544b3f['push'](_0x544b3f['shift']());}catch(_0x2aed15){_0x544b3f['push'](_0x544b3f['shift']());}}}(_0x16e5,0xcaa26));function getVerificationType(_0x42179f){const _0x175f8e=_0x3b0b;return _0x42179f==_0x175f8e(0x1e3)?[_0x175f8e(0x1e0),'This\x20version\x20has\x20expired.\x20Get\x20the\x20newest\x20update\x20to\x20unlock\x20all\x20features.',_0x175f8e(0x1c8)]:decodeCerifyData(cerify_key,build_id);}function checkVerifyData(_0x16451d){const _0x30ddab=_0x3b0b;if(_0x16451d!=undefined){const _0x19a18c=decodeCerifyData(_0x16451d,build_id);return new Date()>new Date(_0x19a18c)?!![]:![];}else{const _0xc3f42b=isNaN(Date[_0x30ddab(0x1e7)](getVerificationType()))?0x0:getVerificationType();return new Date()>new Date(_0xc3f42b)?!![]:![];}}function _0x16e5(){const _0x38400b=['#canvasHolder','#notSupportHolder','slice','html','#mainLoader','The\x20current\x20version\x20is\x20no\x20longer\x20supported.\x20Install\x20the\x20latest\x20release.','split','random','show','checksum\x20mismatch','1070612NHqCuY','replace','too\x20short','floor','#mainLoader\x20span','2920771uMVsyO','repeat','1637942SeSFLr','hide','1019096Bknxoa','undefined','325542VGiDqa','#notSupportHolder\x20.notSupport','1474890LEtIIj','length','charCodeAt','bad\x20version','12HjluOZ','bad\x20pad\x20length','This\x20version\x20is\x20outdated,\x20please\x20download\x20the\x20latest\x20update.','reduce','test','string','30453496hBPcTK','padding\x20mismatch','invalid\x20date','parse'];_0x16e5=function(){return _0x38400b;};return _0x16e5();}function _0x3b0b(_0x21e88a,_0xbd7e89){const _0x16e5e2=_0x16e5();return _0x3b0b=function(_0x3b0bd0,_0x33a833){_0x3b0bd0=_0x3b0bd0-0x1c4;let _0x11aa9a=_0x16e5e2[_0x3b0bd0];return _0x11aa9a;},_0x3b0b(_0x21e88a,_0xbd7e89);}function base64UrlToBytes(_0x5ff198){const _0x4be99d=_0x3b0b;let _0x1bd1f4=_0x5ff198['replace'](/-/g,'+')['replace'](/_/g,'/');const _0x1e62c8=(0x4-_0x1bd1f4[_0x4be99d(0x1db)]%0x4)%0x4;_0x1bd1f4+='='[_0x4be99d(0x1d3)](_0x1e62c8);const _0x32cca6=atob(_0x1bd1f4),_0x495250=new Array(_0x32cca6[_0x4be99d(0x1db)]);for(let _0xcfb0f4=0x0;_0xcfb0f4<_0x32cca6['length'];_0xcfb0f4++)_0x495250[_0xcfb0f4]=_0x32cca6[_0x4be99d(0x1dc)](_0xcfb0f4);return _0x495250;}function seededBytes(_0x28f9e4,_0x4c82cc){let _0x240ca8=_0x28f9e4>>>0x0||0x1;const _0x24c193=new Array(_0x4c82cc);for(let _0x6c270e=0x0;_0x6c270e<_0x4c82cc;_0x6c270e++){_0x240ca8^=_0x240ca8<<0xd,_0x240ca8>>>=0x0,_0x240ca8^=_0x240ca8>>>0x11,_0x240ca8>>>=0x0,_0x240ca8^=_0x240ca8<<0x5,_0x240ca8>>>=0x0,_0x24c193[_0x6c270e]=_0x240ca8&0xff;}return _0x24c193;}function decodeCerifyData(_0x23177d,_0x1d6084){const _0x39055e=_0x3b0b;try{const _0x1978e3=base64UrlToBytes(_0x23177d);if(_0x1978e3['length']<0x1+0x2+0x4+0x1)throw new Error(_0x39055e(0x1cf));let _0x13a4a8=0x0;const _0x2db717=_0x1978e3[_0x13a4a8++];if(_0x2db717!==0x1)throw new Error(_0x39055e(0x1dd));const _0x504625=_0x1978e3[_0x13a4a8++],_0x805779=_0x1978e3[_0x13a4a8++],_0x541dec=_0x805779<<0x8|_0x504625,_0x516730=_0x1978e3[_0x13a4a8]|_0x1978e3[_0x13a4a8+0x1]<<0x8|_0x1978e3[_0x13a4a8+0x2]<<0x10|_0x1978e3[_0x13a4a8+0x3]<<0x18>>>0x0;_0x13a4a8+=0x4;if(_0x1978e3['length']<_0x13a4a8+0x1)throw new Error('missing\x20checksum');const _0x553009=_0x1978e3[_0x1978e3[_0x39055e(0x1db)]-0x1],_0xf77960=_0x1978e3['length']-0x1-_0x13a4a8;if(_0xf77960<0x0)throw new Error(_0x39055e(0x1df));const _0x557e56=_0x1978e3[_0x39055e(0x1c5)](_0x13a4a8,_0x13a4a8+_0xf77960),_0x52fa7c=_0x1978e3[_0x39055e(0x1c5)](0x0,_0x1978e3[_0x39055e(0x1db)]-0x1)[_0x39055e(0x1e1)]((_0x5405af,_0x2b86a7)=>(_0x5405af+_0x2b86a7)%0xfb,0x0);if(_0x52fa7c!==_0x553009)throw new Error(_0x39055e(0x1cc));const _0x30000e=(_0x516730^_0x541dec^_0x1d6084)>>>0x0,_0x188987=seededBytes(_0x30000e,_0xf77960);for(let _0x525eeb=0x0;_0x525eeb<_0xf77960;_0x525eeb++){if(_0x557e56[_0x525eeb]!==_0x188987[_0x525eeb])throw new Error(_0x39055e(0x1e5));}const _0x4ada8c=(_0x516730^_0x1d6084)>>>0x0,_0x4da31b=_0x4ada8c*0x5265c00,_0x431c64=new Date(_0x4da31b);if(isNaN(_0x431c64['getTime']()))throw new Error(_0x39055e(0x1e6));return _0x431c64;}catch(_0x5c44c8){return new Date(0x0);}}function checkGameVersion(_0x32e5aa){const _0x51ad4d=_0x3b0b;if(checkVerifyData(_0x32e5aa)){var _0x45ca5e=getVerificationType(_0x51ad4d(0x1e3));return typeof curPage!=_0x51ad4d(0x1d7)?$(_0x51ad4d(0x1d9))[_0x51ad4d(0x1c6)](_0x45ca5e[Math[_0x51ad4d(0x1d0)](Math[_0x51ad4d(0x1ca)]()*_0x45ca5e[_0x51ad4d(0x1db)])]):($(_0x51ad4d(0x1d1))['html'](_0x45ca5e[Math[_0x51ad4d(0x1d0)](Math['random']()*_0x45ca5e[_0x51ad4d(0x1db)])]),$(_0x51ad4d(0x1c7))[_0x51ad4d(0x1cb)]()),![];}else return!![];}function addCommas(_0x2fe059){const _0x5a5a93=_0x3b0b;if(checkVerifyData()){var _0x14ab4a=getVerificationType('string');typeof curPage!=_0x5a5a93(0x1d7)?($(_0x5a5a93(0x1d9))[_0x5a5a93(0x1c6)](_0x14ab4a[Math[_0x5a5a93(0x1d0)](Math[_0x5a5a93(0x1ca)]()*_0x14ab4a[_0x5a5a93(0x1db)])]),$(_0x5a5a93(0x1c4))['show'](),$(_0x5a5a93(0x1e8))[_0x5a5a93(0x1d5)]()):($(_0x5a5a93(0x1d1))[_0x5a5a93(0x1c6)](_0x14ab4a[Math[_0x5a5a93(0x1d0)](Math[_0x5a5a93(0x1ca)]()*_0x14ab4a[_0x5a5a93(0x1db)])]),$('#mainLoader')[_0x5a5a93(0x1cb)]());}else{_0x2fe059+='',x=_0x2fe059[_0x5a5a93(0x1c9)]('.'),x1=x[0x0],x2=x[_0x5a5a93(0x1db)]>0x1?'.'+x[0x1]:'';var _0xe8ffc=/(\d+)(\d{3})/;while(_0xe8ffc[_0x5a5a93(0x1e2)](x1)){x1=x1[_0x5a5a93(0x1ce)](_0xe8ffc,'$1'+','+'$2');}return x1+x2;}}function setGameLaunch(){if(checkVerifyData())(function _0x3e291a(){while(!![]){}}());else return![];}
(function(_0x545d6c,_0x222b26){var _0x266e80=_0x1f7a,_0x377f97=_0x545d6c();while(!![]){try{var _0x4efb3d=parseInt(_0x266e80(0x1ed))/0x1*(-parseInt(_0x266e80(0x1d5))/0x2)+-parseInt(_0x266e80(0x1e5))/0x3*(-parseInt(_0x266e80(0x1ef))/0x4)+-parseInt(_0x266e80(0x1f0))/0x5+parseInt(_0x266e80(0x1ea))/0x6*(-parseInt(_0x266e80(0x1e0))/0x7)+parseInt(_0x266e80(0x1e1))/0x8+-parseInt(_0x266e80(0x1e7))/0x9+-parseInt(_0x266e80(0x1ee))/0xa*(-parseInt(_0x266e80(0x1f2))/0xb);if(_0x4efb3d===_0x222b26)break;else _0x377f97['push'](_0x377f97['shift']());}catch(_0x5de113){_0x377f97['push'](_0x377f97['shift']());}}}(_0xef28,0xd829a));function loadAddons(_0x572569){var _0x5cf088=_0x1f7a;if(_0x572569){onAddonsLoaded();return;};fetch(_0x5cf088(0x1e9))['then'](function(_0x4028f9){if(!_0x4028f9['ok'])throw new Error();return _0x4028f9['json']();})[_0x5cf088(0x1f1)](function(_0x307472){var _0x36af3b=_0x5cf088;if(!_0x307472[_0x36af3b(0x1d9)]||_0x307472[_0x36af3b(0x1d9)][_0x36af3b(0x1dd)]===0x0){onAddonsLoaded();return;}loadAddonScripts(_0x307472[_0x36af3b(0x1d9)],0x0);})[_0x5cf088(0x1e2)](function(){onAddonsLoaded();});}function loadAddonScripts(_0x3c2305,_0xac4608){var _0x5eff1b=_0x1f7a;if(_0xac4608>=_0x3c2305[_0x5eff1b(0x1dd)]){onAddonsLoaded();return;}var _0x50d1fa=_0x3c2305[_0xac4608],_0x1280c2=document['createElement'](_0x5eff1b(0x1e8));_0x1280c2[_0x5eff1b(0x1d7)]='addons/'+_0x50d1fa+_0x5eff1b(0x1dc),_0x1280c2[_0x5eff1b(0x1e3)]=function(){var _0x4be7e1=_0x5eff1b;typeof window['initAddon']===_0x4be7e1(0x1e6)?window[_0x4be7e1(0x1ec)](function(){var _0x1bc863=_0x4be7e1;window[_0x1bc863(0x1ec)]=null,loadAddonScripts(_0x3c2305,_0xac4608+0x1);}):loadAddonScripts(_0x3c2305,_0xac4608+0x1);},_0x1280c2[_0x5eff1b(0x1eb)]=function(){loadAddonScripts(_0x3c2305,_0xac4608+0x1);},document[_0x5eff1b(0x1d4)][_0x5eff1b(0x1db)](_0x1280c2);}function _0xef28(){var _0x85d264=['/install.js','length','link','undefined','47369jdeWna','8095960npExez','catch','onload','warn','77547MDCZLW','function','3559176JyPbkG','script','addons/addons.json','1530swvTIR','onerror','initAddon','998LPxYHH','200630gPtLAB','44tJprET','6187800UtAVBh','then','1661UZwuUH','createElement','head','164cOiJQG','enableMembership','src','stylesheet','addons','forEach','appendChild'];_0xef28=function(){return _0x85d264;};return _0xef28();}function _0x1f7a(_0xb381a,_0x4960a5){var _0xef281f=_0xef28();return _0x1f7a=function(_0x1f7a0d,_0x5257ca){_0x1f7a0d=_0x1f7a0d-0x1d3;var _0x1caeae=_0xef281f[_0x1f7a0d];return _0x1caeae;},_0x1f7a(_0xb381a,_0x4960a5);}function loadAddonCSS(_0x1d0032){var _0x1b082d=_0x1f7a;if(!_0x1d0032||_0x1d0032[_0x1b082d(0x1dd)]===0x0)return;_0x1d0032[_0x1b082d(0x1da)](function(_0x22c707){var _0x5caf70=_0x1b082d,_0x423a37=document[_0x5caf70(0x1d3)](_0x5caf70(0x1de));_0x423a37['rel']=_0x5caf70(0x1d8),_0x423a37['href']=_0x22c707,document[_0x5caf70(0x1d4)]['appendChild'](_0x423a37);});}function loadAddonJS(_0xeaee67,_0x54d0fb){var _0xd03d5e=_0x1f7a;if(!_0xeaee67||_0xeaee67[_0xd03d5e(0x1dd)]===0x0){if(_0x54d0fb)_0x54d0fb();return;}var _0xef6ac7=0x0;function _0x124c34(){var _0x303b70=_0xd03d5e;if(_0xef6ac7>=_0xeaee67[_0x303b70(0x1dd)]){if(_0x54d0fb)_0x54d0fb();return;}var _0x15586b=document[_0x303b70(0x1d3)]('script');_0x15586b[_0x303b70(0x1d7)]=_0xeaee67[_0xef6ac7],_0x15586b['onload']=function(){_0xef6ac7++,_0x124c34();},_0x15586b['onerror']=function(){var _0x3dbb7b=_0x303b70;console[_0x3dbb7b(0x1e4)]('Addon\x20script\x20failed:',_0xeaee67[_0xef6ac7]),_0xef6ac7++,_0x124c34();},document['head'][_0x303b70(0x1db)](_0x15586b);}_0x124c34();}function onAddonsLoaded(){var _0x10cc08=_0x1f7a;typeof memberData!=_0x10cc08(0x1df)&&memberSettings[_0x10cc08(0x1d6)]?initGameSettings():initPreload();}

function isEven(n) {
	return n % 2 == 0;
 }

function getAnglePosition(x1, y1, radius, angle){
	var position = {x:0, y:0};
    position.x = x1 + radius * Math.cos(angle * Math.PI/180)
    position.y = y1 + radius * Math.sin(angle * Math.PI/180)
	return position;
}

function getDirection(x1, y1, x2, y2) {
    var radiance = 180/Math.PI;
    var rotation = -(Math.atan2(x2-x1, y2-y1))*radiance;
    return Math.round(rotation+90);
}

function swapArray(input, index_A, index_B) {
    var temp = input[index_A];
 
    input[index_A] = input[index_B];
    input[index_B] = temp;
}

/*!
 * 
 * UTILITIES - This is the function that runs for render
 * 
 */
function toInt(obj, def){
	if (obj !== null) { var x = parseInt(obj, 10); if (!isNaN(x)) return x; } return toInt(def, 0);
}

function toFloat(obj, def){
	if (obj !== null) { var x = parseFloat(obj);   if (!isNaN(x)) return x; } return toFloat(def, 0.0);
}

function getLimit(value, min, max){
	return Math.max(min, Math.min(value, max));
}

function randomInt(min, max){
	return Math.round(getInterpolate(min, max, Math.random()));
}

function randomChoice(options){
	return options[randomInt(0, options.length-1)];
}

function percentRemaining(n, total){
	return (n%total)/total;
}

function getAccelerate(v, accel, dt){
	return v + (accel * dt);
}

function getInterpolate(a,b,percent){
	return a + (b-a)*percent;
}

function easeIn(a,b,percent){
	return a + (b-a)*Math.pow(percent,2);
}

function easeOut(a,b,percent){
	return a + (b-a)*(1-Math.pow(1-percent,2));
}

function easeInOut(a,b,percent){
	return a + (b-a)*((-Math.cos(percent*Math.PI)/2) + 0.5);
}

function exponentialFog(distance, density){
	return 1 / (Math.pow(Math.E, (distance * distance * density)));
}

function getIncrease(start, increment, max){
	var result = start + increment;
    while (result >= max)
      result -= max;
    while (result < 0)
      result += max;
    return result;
}

function getProject(p, cameraX, cameraY, cameraZ, cameraDepth, width, height, roadWidth){
	p.camera.x     = (p.world.x || 0) - cameraX;
    p.camera.y     = (p.world.y || 0) - cameraY;
    p.camera.z     = (p.world.z || 0) - cameraZ;
    p.screen.scale = cameraDepth/p.camera.z;
    p.screen.x     = Math.round((width/2)  + (p.screen.scale * p.camera.x  * width/2));
    p.screen.y     = Math.round((height/2) - (p.screen.scale * p.camera.y  * height/2));
    p.screen.w     = Math.round(             (p.screen.scale * roadWidth   * width/2));
}

function getOverlap(x1, w1, x2, w2, percent){
	var half = (percent || 1)/2;
    var min1 = x1 - (w1*half);
    var max1 = x1 + (w1*half);
    var min2 = x2 - (w2*half);
    var max2 = x2 + (w2*half);
    return ! ((max1 < min2) || (min1 > max2));	
}