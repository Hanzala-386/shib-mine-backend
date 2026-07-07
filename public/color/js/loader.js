////////////////////////////////////////////////////////////
// CANVAS LOADER
////////////////////////////////////////////////////////////

 /*!
 * 
 * START CANVAS PRELOADER - This is the function that runs to preload canvas asserts
 * 
 */
function initPreload(){
	toggleLoader(true);
	checkMobileEvent();
	
	$(window).resize(function(){
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(checkMobileOrientation, 1000);
	});
	resizeGameFunc();
	
	loader = new createjs.LoadQueue(false);
	manifest=[
		{src:'assets/background.png', id:'background'},
		{src:'assets/background_p.png', id:'backgroundP'},
		{src:'assets/logo.png', id:'logo'},
		{src:'assets/button_start.png', id:'buttonStart'},
	
		{src:'assets/button_share.png', id:'buttonShare'},
		{src:'assets/button_save.png', id:'buttonSave'},
		{src:'assets/social/button_facebook.png', id:'buttonFacebook'},
		{src:'assets/social/button_twitter.png', id:'buttonTwitter'},
		{src:'assets/social/button_whatsapp.png', id:'buttonWhatsapp'},
		{src:'assets/social/button_telegram.png', id:'buttonTelegram'},
		{src:'assets/social/button_reddit.png', id:'buttonReddit'},
		{src:'assets/social/button_linkedin.png', id:'buttonLinkedin'},

		{src:'assets/button_continue.png', id:'buttonContinue'},
		{src:'assets/item_result.png', id:'itemResult'},
		{src:'assets/item_result_p.png', id:'itemResultP'},
		{src:'assets/button_confirm.png', id:'buttonConfirm'},
		{src:'assets/button_cancel.png', id:'buttonCancel'},
		{src:'assets/button_fullscreen.png', id:'buttonFullscreen'},
		{src:'assets/button_sound_on.png', id:'buttonSoundOn'},
		{src:'assets/button_sound_off.png', id:'buttonSoundOff'},
		{src:'assets/button_music_on.png', id:'buttonMusicOn'},
		{src:'assets/button_music_off.png', id:'buttonMusicOff'},
		{src:'assets/button_exit.png', id:'buttonExit'},
		{src:'assets/button_settings.png', id:'buttonSettings'}
	];

	for(let n=0; n<ballsSettings.length; n++){
		for(let b=0; b<ballsSettings[n].balls.length; b++){
			manifest.push({src:ballsSettings[n].balls[b].main, id:'ballMain'+n+'_'+b});
			manifest.push({src:ballsSettings[n].balls[b].collect, id:'ballCollect'+n+'_'+b});
			manifest.push({src:ballsSettings[n].balls[b].trail, id:'ballTrail'+n+'_'+b});
		}
	}

	for(let n=0; n<themeSettings.length; n++){
		manifest.push({src:themeSettings[n].background, id:'background'+n});
		manifest.push({src:themeSettings[n].backgroundShapes, id:'backgroundShapes'+n});
	}
	
	if ( typeof addScoreboardAssets == 'function' ) { 
		addScoreboardAssets();
	}
	
	audioOn = true;
	if(!isDesktop){
		if(!enableMobileAudio){
			audioOn=false;
		}
	}else{
		if(!enableDesktopAudio){
			audioOn=false;
		}
	}
	
	if(audioOn){
		manifest.push({src:'assets/sounds/sound_click.ogg', id:'soundButton'});
		manifest.push({src:'assets/sounds/sound_fail.ogg', id:'soundFail'});
		manifest.push({src:'assets/sounds/sound_success1.ogg', id:'soundSuccess1'});
		manifest.push({src:'assets/sounds/sound_success2.ogg', id:'soundSuccess2'});
		manifest.push({src:'assets/sounds/sound_success3.ogg', id:'soundSuccess3'});
		manifest.push({src:'assets/sounds/sound_move.ogg', id:'soundMove'});
		manifest.push({src:'assets/sounds/sound_move_error.ogg', id:'soundMoveError'});
		manifest.push({src:'assets/sounds/sound_result.ogg', id:'soundResult'});
		manifest.push({src:'assets/sounds/sound_start.ogg', id:'soundStart'});
		manifest.push({src:'assets/sounds/music_main.ogg', id:'musicMain'});
		manifest.push({src:'assets/sounds/music_game.ogg', id:'musicGame'});
		
		createjs.Sound.alternateExtensions = ["mp3"];
		loader.installPlugin(createjs.Sound);
	}
	
	loader.addEventListener("complete", handleComplete);
	loader.addEventListener("fileload", fileComplete);
	loader.addEventListener("error",handleFileError);
	loader.on("progress", handleProgress, this);
	loader.loadManifest(manifest);
}

/*!
 * 
 * CANVAS FILE COMPLETE EVENT - This is the function that runs to update when file loaded complete
 * 
 */
function fileComplete(evt) {
	var item = evt.item;
	//console.log("Event Callback file loaded ", item.id);
}

/*!
 * 
 * CANVAS FILE HANDLE EVENT - This is the function that runs to handle file error
 * 
 */
function handleFileError(evt) {
	console.log("error ", evt);
}

/*!
 * 
 * CANVAS PRELOADER UPDATE - This is the function that runs to update preloder progress
 * 
 */
function handleProgress() {
	$('#mainLoader span').html(Math.round(loader.progress/1*100)+'%');
}

/*!
 * 
 * CANVAS PRELOADER COMPLETE - This is the function that runs when preloader is complete
 * 
 */
function handleComplete() {
	toggleLoader(false);
	initMain();
};

/*!
 * 
 * TOGGLE LOADER - This is the function that runs to display/hide loader
 * 
 */
function toggleLoader(con){
	if(con){
		$('#mainLoader').show();
	}else{
		$('#mainLoader').hide();
	}
}