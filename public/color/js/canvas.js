////////////////////////////////////////////////////////////
// CANVAS
////////////////////////////////////////////////////////////
var stage;
var canvasW=0;
var canvasH=0;

/*!
 * 
 * START GAME CANVAS - This is the function that runs to setup game canvas
 * 
 */
function initGameCanvas(w,h){
	const gameCanvas = document.getElementById("gameCanvas");
	gameCanvas.width = w;
	gameCanvas.height = h;
	
	canvasW=w;
	canvasH=h;
	stage = new createjs.Stage("gameCanvas",{ antialias: true });
	
	createjs.Touch.enable(stage);
	// Hover hit-testing is desktop-only cosmetics; on touch devices it burns 20 display-list scans/sec
if (!('ontouchstart' in window)) { stage.enableMouseOver(20); }
	stage.mouseMoveOutside = true;
	
	createjs.Ticker.framerate = 60;
// RAF render pacing (vsync-aligned, smoother than setTimeout on mobile WebViews)
if (createjs.Ticker.RAF){ createjs.Ticker.timingMode = createjs.Ticker.RAF; }
	createjs.Ticker.addEventListener("tick", tick);
}

var safeZoneGuide = false;
var canvasContainer, mainContainer, gameContainer, resultContainer, exitContainer, optionsContainer, shareContainer, shareSaveContainer, socialContainer;
var guideline, bg, bgP, logo, logoP;
var itemExit, itemExitP, popTitleTxt, popDescTxt, buttonConfirm, buttonCancel;
var itemResult, itemResultP, buttonContinue, resultTitleTxt, resultDescTxt, buttonShare, buttonSave;
var resultTitleOutlineTxt,resultDescOutlineTxt,resultShareTxt,resultShareOutlineTxt,resultScoreTxt,popTitleOutlineTxt,popDescOutlineTxt;
var buttonSettings, buttonFullscreen, buttonSoundOn, buttonSoundOff, buttonMusicOn, buttonMusicOff, buttonExit;
$.share = {};

var bgWorldContainer,worldContainer,explodeContainer,particlesContainer,statusContainer;
var buttonStart,gameInstructionTxt,gameScoreTxt,gameStatusTxt,gameInstructionShadowTxt,gameScoreShadowTxt,gameStatusShadowTxt,gameDistanceTxt,gameDistanceShadowTxt,touchScreen,resultDistanceTxt;
$.sprites = {};

/*!
 * 
 * BUILD GAME CANVAS ASSERTS - This is the function that runs to build game canvas asserts
 * 
 */
function buildGameCanvas(){
	canvasContainer = new createjs.Container();
	mainContainer = new createjs.Container();
	gameContainer = new createjs.Container();
	exitContainer = new createjs.Container();
	resultContainer = new createjs.Container();
	shareContainer = new createjs.Container();
	shareSaveContainer = new createjs.Container();
	socialContainer = new createjs.Container();

	bgWorldContainer = new createjs.Container();
	worldContainer = new createjs.Container();
	explodeContainer = new createjs.Container();
	particlesContainer = new createjs.Container();
	scoreContainer = new createjs.Container();
	statusContainer = new createjs.Container();
	instructionContainer = new createjs.Container();
	
	
	bg = new createjs.Bitmap(loader.getResult('background'));
	bgP = new createjs.Bitmap(loader.getResult('backgroundP'));
	logo = new createjs.Bitmap(loader.getResult('logo'));
	centerReg(logo);
	
	buttonStart = new createjs.Bitmap(loader.getResult('buttonStart'));
	centerReg(buttonStart);
	
	//game
	gameInstructionTxt = new createjs.Text();
	gameInstructionTxt.font = "25px russo_oneregular";
	gameInstructionTxt.color = '#fff';
	gameInstructionTxt.textAlign = "center";
	gameInstructionTxt.textBaseline='alphabetic';

	gameScoreTxt = new createjs.Text();
	gameScoreTxt.font = "70px russo_oneregular";
	gameScoreTxt.color = '#fff';
	gameScoreTxt.textAlign = "center";
	gameScoreTxt.textBaseline='alphabetic';

	gameStatusTxt = new createjs.Text();
	gameStatusTxt.font = "50px russo_oneregular";
	gameStatusTxt.color = '#fff';
	gameStatusTxt.textAlign = "center";
	gameStatusTxt.textBaseline='alphabetic';
	gameStatusTxt.text = textStrings.gameOver;

	gameInstructionShadowTxt = new createjs.Text();
	gameInstructionShadowTxt.font = "25px russo_oneregular";
	gameInstructionShadowTxt.color = '#000';
	gameInstructionShadowTxt.textAlign = "center";
	gameInstructionShadowTxt.textBaseline='alphabetic';
	gameInstructionShadowTxt.y = 5;
	gameInstructionShadowTxt.alpha = .5;

	gameScoreShadowTxt = new createjs.Text();
	gameScoreShadowTxt.font = "70px russo_oneregular";
	gameScoreShadowTxt.color = '#000';
	gameScoreShadowTxt.textAlign = "center";
	gameScoreShadowTxt.textBaseline='alphabetic';
	gameScoreShadowTxt.y = 10;
	gameScoreShadowTxt.alpha = .8;

	gameStatusShadowTxt = new createjs.Text();
	gameStatusShadowTxt.font = "50px russo_oneregular";
	gameStatusShadowTxt.color = '#000';
	gameStatusShadowTxt.textAlign = "center";
	gameStatusShadowTxt.textBaseline='alphabetic';
	gameStatusShadowTxt.text = textStrings.gameOver;
	gameStatusShadowTxt.y = 8;
	gameStatusShadowTxt.alpha = .8;

	gameDistanceTxt = new createjs.Text();
	gameDistanceTxt.font = "25px russo_oneregular";
	gameDistanceTxt.color = '#fff';
	gameDistanceTxt.textAlign = "center";
	gameDistanceTxt.textBaseline='alphabetic';
	gameDistanceTxt.y = 40;

	gameDistanceShadowTxt = new createjs.Text();
	gameDistanceShadowTxt.font = "25px russo_oneregular";
	gameDistanceShadowTxt.color = '#000';
	gameDistanceShadowTxt.textAlign = "center";
	gameDistanceShadowTxt.textBaseline='alphabetic';
	gameDistanceShadowTxt.text = textStrings.gameOver;
	gameDistanceShadowTxt.y = gameDistanceTxt.y + 5;
	gameDistanceShadowTxt.alpha = .8;

	statusContainer.addChild(gameStatusShadowTxt, gameStatusTxt);
	scoreContainer.addChild(gameScoreShadowTxt, gameScoreTxt, gameDistanceShadowTxt, gameDistanceTxt);
	instructionContainer.addChild(gameInstructionShadowTxt, gameInstructionTxt);
	
	for(var n=0; n<ballsSettings.length; n++){
		for(var b=0; b<ballsSettings[n].balls.length; b++){
			$.sprites['ballMain'+n+'_'+b] = new createjs.Bitmap(loader.getResult('ballMain'+n+'_'+b));
			centerReg($.sprites['ballMain'+n+'_'+b]);
			$.sprites['ballMain'+n+'_'+b].y -= $.sprites['ballMain'+n+'_'+b].image.naturalHeight;
			$.sprites['ballCollect'+n+'_'+b] = new createjs.Bitmap(loader.getResult('ballCollect'+n+'_'+b));
			centerReg($.sprites['ballCollect'+n+'_'+b]);
			$.sprites['ballCollect'+n+'_'+b].y -= $.sprites['ballCollect'+n+'_'+b].image.naturalHeight;
			$.sprites['ballTrail'+n+'_'+b] = new createjs.Bitmap(loader.getResult('ballTrail'+n+'_'+b));
			centerReg($.sprites['ballTrail'+n+'_'+b]);
			$.sprites['ballTrail'+n+'_'+b].y -= $.sprites['ballTrail'+n+'_'+b].image.naturalHeight;
		}
	}

	touchScreen = new createjs.Shape();	
	touchScreen.hitArea = new createjs.Shape(new createjs.Graphics().beginFill("#000").drawRect(-(landscapeSize.w/2), -(portraitSize.h/2), landscapeSize.w, portraitSize.h));
	
	//result
	itemResult = new createjs.Bitmap(loader.getResult('itemResult'));
	centerReg(itemResult);
	itemResultP = new createjs.Bitmap(loader.getResult('itemResultP'));
	centerReg(itemResultP);
	
	buttonContinue = new createjs.Bitmap(loader.getResult('buttonContinue'));
	centerReg(buttonContinue);
	
	resultTitleTxt = new createjs.Text();
	resultTitleTxt.font = "60px russo_oneregular";
	resultTitleTxt.color = '#098fc8';
	resultTitleTxt.textAlign = "center";
	resultTitleTxt.textBaseline='alphabetic';
	resultTitleTxt.text = textStrings.resultTitle;

	resultTitleOutlineTxt = new createjs.Text();
	resultTitleOutlineTxt.font = "60px russo_oneregular";
	resultTitleOutlineTxt.color = '#000';
	resultTitleOutlineTxt.textAlign = "center";
	resultTitleOutlineTxt.textBaseline='alphabetic';
	resultTitleOutlineTxt.outline = 6;
	resultTitleOutlineTxt.text = textStrings.resultTitle;
	
	resultDescTxt = new createjs.Text();
	resultDescTxt.font = "90px russo_oneregular";
	resultDescTxt.color = '#424553';
	resultDescTxt.textAlign = "center";
	resultDescTxt.textBaseline='alphabetic';
	resultDescTxt.text = textStrings.resultDesc;

	resultDescOutlineTxt = new createjs.Text();
	resultDescOutlineTxt.font = "90px russo_oneregular";
	resultDescOutlineTxt.color = '#000';
	resultDescOutlineTxt.textAlign = "center";
	resultDescOutlineTxt.textBaseline='alphabetic';
	resultDescOutlineTxt.outline = 8;

	resultDistanceTxt = new createjs.Text();
	resultDistanceTxt.font = "35px russo_oneregular";
	resultDistanceTxt.color = '#424553';
	resultDistanceTxt.textAlign = "center";
	resultDistanceTxt.textBaseline='alphabetic';
	resultDistanceTxt.text = '';

	resultTitleTxt.y = resultTitleOutlineTxt.y = -140;
	resultDistanceTxt.y = -95;
	resultDescTxt.y = resultDescOutlineTxt.y = -20;
	buttonContinue.y = 150;

	resultShareTxt = new createjs.Text();
	resultShareTxt.font = "30px russo_oneregular";
	resultShareTxt.color = '#098fc8';
	resultShareTxt.textAlign = "center";
	resultShareTxt.textBaseline='alphabetic';
	resultShareTxt.text = textStrings.share;

	resultShareOutlineTxt = new createjs.Text();
	resultShareOutlineTxt.font = "30px russo_oneregular";
	resultShareOutlineTxt.color = '#000';
	resultShareOutlineTxt.textAlign = "center";
	resultShareOutlineTxt.textBaseline='alphabetic';
	resultShareOutlineTxt.outline = 4;
	resultShareOutlineTxt.text = textStrings.share;

	resultTitleOutlineTxt.visible = resultDescOutlineTxt.visible = resultShareOutlineTxt.visible = false;

	shareContainer.y = shareSaveContainer.y = 15;
	socialContainer.visible = false;
	socialContainer.scale = .9;
	shareContainer.addChild(resultShareOutlineTxt, resultShareTxt, socialContainer);

	if(shareSettings.enable){
		buttonShare = new createjs.Bitmap(loader.getResult('buttonShare'));
		centerReg(buttonShare);
		
		var pos = {x:0, y:40, spaceX:65};
		pos.x = -(((shareSettings.options.length-1) * pos.spaceX)/2)
		for(let n=0; n<shareSettings.options.length; n++){
			var shareOption = shareSettings.options[n];
			var shareAsset = String(shareOption[0]).toUpperCase() + String(shareOption).slice(1);
			$.share['button'+n] = new createjs.Bitmap(loader.getResult('button'+shareAsset));
			$.share['button'+n].shareOption = shareOption;
			centerReg($.share['button'+n]);
			$.share['button'+n].x = pos.x;
			$.share['button'+n].y = pos.y;
			socialContainer.addChild($.share['button'+n]);
			pos.x += pos.spaceX;
		}
		buttonShare.y = (buttonShare.image.naturalHeight/2) + 10;
		shareContainer.addChild(buttonShare);
	}

	if ( typeof toggleScoreboardSave == 'function' ) { 
		buttonSave = new createjs.Bitmap(loader.getResult('buttonSave'));
		centerReg(buttonSave);
        buttonSave.y = (buttonSave.image.naturalHeight/2) + 10;
        shareSaveContainer.addChild(buttonSave);
	}
	
	//options	
	buttonFullscreen = new createjs.Bitmap(loader.getResult('buttonFullscreen'));
	centerReg(buttonFullscreen);
	buttonSoundOn = new createjs.Bitmap(loader.getResult('buttonSoundOn'));
	centerReg(buttonSoundOn);
	buttonSoundOff = new createjs.Bitmap(loader.getResult('buttonSoundOff'));
	centerReg(buttonSoundOff);
	buttonSoundOn.visible = false;
	buttonMusicOn = new createjs.Bitmap(loader.getResult('buttonMusicOn'));
	centerReg(buttonMusicOn);
	buttonMusicOff = new createjs.Bitmap(loader.getResult('buttonMusicOff'));
	centerReg(buttonMusicOff);
	buttonMusicOn.visible = false;
	
	buttonExit = new createjs.Bitmap(loader.getResult('buttonExit'));
	centerReg(buttonExit);
	buttonSettings = new createjs.Bitmap(loader.getResult('buttonSettings'));
	centerReg(buttonSettings);
	
	createHitarea(buttonFullscreen);
	createHitarea(buttonSoundOn);
	createHitarea(buttonSoundOff);
	createHitarea(buttonMusicOn);
	createHitarea(buttonMusicOff);
	createHitarea(buttonExit);
	createHitarea(buttonSettings);
	optionsContainer = new createjs.Container();
	optionsContainer.addChild(buttonFullscreen, buttonSoundOn, buttonSoundOff, buttonMusicOn, buttonMusicOff, buttonExit);
	optionsContainer.visible = false;
	
	//exit
	itemExit = new createjs.Bitmap(loader.getResult('itemResult'));
	centerReg(itemExit);
	itemExitP = new createjs.Bitmap(loader.getResult('itemResultP'));
	centerReg(itemExitP);
	
	buttonConfirm = new createjs.Bitmap(loader.getResult('buttonConfirm'));
	centerReg(buttonConfirm);
	
	buttonCancel = new createjs.Bitmap(loader.getResult('buttonCancel'));
	centerReg(buttonCancel);
	
	popTitleTxt = new createjs.Text();
	popTitleTxt.font = "60px russo_oneregular";
	popTitleTxt.color = "#098fc8";
	popTitleTxt.textAlign = "center";
	popTitleTxt.textBaseline='alphabetic';
	popTitleTxt.text = textStrings.exitTitle;

	popTitleOutlineTxt = new createjs.Text();
	popTitleOutlineTxt.font = "60px russo_oneregular";
	popTitleOutlineTxt.color = '#000';
	popTitleOutlineTxt.textAlign = "center";
	popTitleOutlineTxt.textBaseline='alphabetic';
	popTitleOutlineTxt.outline = 6;
	popTitleOutlineTxt.text = textStrings.exitTitle;
	
	popDescTxt = new createjs.Text();
	popDescTxt.font = "40px russo_oneregular";
	popDescTxt.lineHeight = 35;
	popDescTxt.color = "#424553";
	popDescTxt.textAlign = "center";
	popDescTxt.textBaseline='alphabetic';
	popDescTxt.text = textStrings.exitMessage;

	popDescOutlineTxt = new createjs.Text();
	popDescOutlineTxt.font = "40px russo_oneregular";
	popDescOutlineTxt.lineHeight = 35;
	popDescOutlineTxt.color = '#000';
	popDescOutlineTxt.textAlign = "center";
	popDescOutlineTxt.textBaseline='alphabetic';
	popDescOutlineTxt.outline = 4;
	popDescOutlineTxt.text = textStrings.exitMessage;

	popTitleTxt.y = popTitleOutlineTxt.y = -140;
	popDescTxt.y = popDescOutlineTxt.y = -80;
	buttonConfirm.x = 0;
	buttonConfirm.y = 55;
	buttonCancel.x = 0;
	buttonCancel.y = 150;

	popTitleOutlineTxt.visible = popDescOutlineTxt.visible = false;
	
	exitContainer.addChild(itemExit, itemExitP, popTitleOutlineTxt, popTitleTxt, popDescOutlineTxt, popDescTxt, buttonConfirm, buttonCancel);
	exitContainer.visible = false;
	
	guideline = new createjs.Shape();
	
	mainContainer.addChild(logo, buttonStart);
	gameContainer.addChild(particlesContainer, explodeContainer, touchScreen, statusContainer, scoreContainer, instructionContainer);
	resultContainer.addChild(itemResult, itemResultP, buttonContinue, resultTitleOutlineTxt, resultTitleTxt, resultDescOutlineTxt, resultDescTxt, resultDistanceTxt, shareContainer, shareSaveContainer);
	
	canvasContainer.addChild(bg, bgP, bgWorldContainer, worldContainer, mainContainer, gameContainer, resultContainer, exitContainer, optionsContainer, buttonSettings, guideline);
	stage.addChild(canvasContainer);
	
	changeViewport(viewport.isLandscape);
	resizeGameFunc();
}

function changeViewport(isLandscape){
	if(isLandscape){
		//landscape
		stageW=landscapeSize.w;
		stageH=landscapeSize.h;
		contentW = landscapeSize.cW;
		contentH = landscapeSize.cH;

		defaultData.width = defaultData.viewport.landscape.w;
		defaultData.height = defaultData.viewport.landscape.h;
		defaultData.scale = defaultData.viewport.landscape.scale;
	}else{
		//portrait
		stageW=portraitSize.w;
		stageH=portraitSize.h;
		contentW = portraitSize.cW;
		contentH = portraitSize.cH;

		defaultData.width = defaultData.viewport.portrait.w;
		defaultData.height = defaultData.viewport.portrait.h;
		defaultData.scale = defaultData.viewport.portrait.scale;
	}
	
	canvasW=stageW;
	canvasH=stageH;
	
	changeCanvasViewport();
}

function changeCanvasViewport(){
	if(canvasContainer!=undefined){
		stage.scaleX = stage.scaleY = dpr;
		
		if(safeZoneGuide){	
			guideline.graphics.clear().setStrokeStyle(2).beginStroke('red').drawRect((stageW-contentW)/2, (stageH-contentH)/2, contentW, contentH);
		}

		exitContainer.x = canvasW/2;
		exitContainer.y = canvasH/2;

		resultContainer.x = canvasW/2;
		resultContainer.y = canvasH/2;

		logo.scaleX = logo.scaleY = 1;
		
		if(viewport.isLandscape){
			bg.visible = true;
			bgP.visible = false;
			
			logo.x = canvasW/2;
			logo.y = canvasH/100 * 40;
			
			buttonStart.x = canvasW/2;
			buttonStart.y = canvasH/100 * 75;
			
			//game
			
			//result
			itemResult.visible = true;
			itemResultP.visible = false;
			
			//exit
			itemExit.visible = true;
			itemExitP.visible = false;
		}else{
			bg.visible = false;
			bgP.visible = true;
			
			logo.x = canvasW/2;
			logo.y = canvasH/100 * 40;
			logo.scaleX = logo.scaleY = .8;
			
			buttonStart.x = canvasW/2;
			buttonStart.y = canvasH/100 * 60;
			
			//game
			
			//result
			itemResult.visible = false;
			itemResultP.visible = true;
			
			//exit
			itemExit.visible = false;
			itemExitP.visible = true;
		}
	}
}



/*!
 * 
 * RESIZE GAME CANVAS - This is the function that runs to resize game canvas
 * 
 */
function resizeCanvas(){
 	if(canvasContainer!=undefined){
		
		buttonSettings.x = (canvasW - offset.x) - 50;
		buttonSettings.y = offset.y + 45;
		
		var distanceNum = 60;
		var nextCount = 0;
		buttonSoundOn.x = buttonSoundOff.x = buttonSettings.x;
		buttonSoundOn.y = buttonSoundOff.y = buttonSettings.y+distanceNum;
		buttonSoundOn.x = buttonSoundOff.x;
		buttonSoundOn.y = buttonSoundOff.y = buttonSettings.y+distanceNum;
		if (typeof buttonMusicOn != "undefined") {
			buttonMusicOn.x = buttonMusicOff.x = buttonSettings.x;
			buttonMusicOn.y = buttonMusicOff.y = buttonSettings.y+(distanceNum*2);
			buttonMusicOn.x = buttonMusicOff.x;
			buttonMusicOn.y = buttonMusicOff.y = buttonSettings.y+(distanceNum*2);
			nextCount = 2;
		}else{
			nextCount = 1;
		}
		buttonFullscreen.x = buttonSettings.x;
		buttonFullscreen.y = buttonSettings.y+(distanceNum*(nextCount+1));

		if(curPage == 'main' || curPage == 'result'){
			buttonExit.visible = false;			
			buttonFullscreen.x = buttonSettings.x;
			buttonFullscreen.y = buttonSettings.y+(distanceNum*(nextCount+1));
		}else{
			buttonExit.visible = !(window.__arcadeColorMatch && window.__arcadeColorMatch()); buttonExit.mouseEnabled = !(window.__arcadeColorMatch && window.__arcadeColorMatch());			
			buttonExit.x = buttonSettings.x;
			buttonExit.y = buttonSettings.y+(distanceNum*(nextCount+2));
		}

		resizeGame();
	}
}

/*!
 * 
 * REMOVE GAME CANVAS - This is the function that runs to remove game canvas
 * 
 */
 function removeGameCanvas(){
	 stage.autoClear = true;
	 stage.removeAllChildren();
	 stage.update();
	 createjs.Ticker.removeEventListener("tick", tick);
	 createjs.Ticker.removeEventListener("tick", stage);
 }

/*!
 * 
 * CANVAS LOOP - This is the function that runs for canvas loop
 * 
 */ 
// Fixed-timestep accumulator (Session 8 pattern): updateGame() always simulates
// 1/60s per step, so game speed is wall-clock identical on every device. A
// lagging low-end phone just runs catch-up steps (cap 4); a 120Hz display
// steps every other frame. Rendering (stage.update) happens once per tick.
var STEP_MS = 1000 / 60;
var MAX_STEPS = 4;
var _stepAccum = 0;
function tick(event) {
	var elapsed = (event && typeof event.delta === 'number') ? event.delta : STEP_MS;
	if (elapsed < 0) elapsed = 0;
	if (elapsed > STEP_MS * MAX_STEPS) elapsed = STEP_MS * MAX_STEPS;
	_stepAccum += elapsed;
	var steps = 0;
	while (_stepAccum >= STEP_MS && steps < MAX_STEPS) {
		updateGame(event);
		_stepAccum -= STEP_MS;
		steps++;
	}
	stage.update(event);
}

/*!
 * 
 * CANVAS MISC FUNCTIONS
 * 
 */
function centerReg(obj){
	if(obj.image == undefined){
		return;
	}

	obj.regX=obj.image.naturalWidth/2;
	obj.regY=obj.image.naturalHeight/2;
}

function createHitarea(obj){
	obj.hitArea = new createjs.Shape(new createjs.Graphics().beginFill("#000").drawRect(0, 0, obj.image.naturalWidth, obj.image.naturalHeight));
}