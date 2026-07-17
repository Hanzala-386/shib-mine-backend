////////////////////////////////////////////////////////////
// GAME v1.2
////////////////////////////////////////////////////////////

/*!
 * 
 * GAME SETTING CUSTOMIZATION START
 * 
 */
const ballsSettings = [
	{
		balls:[
			{
				main:'assets/ball_a_1.png',
				collect:'assets/ball_a_1c.png',
				trail:'assets/ball_a_1t.png',
				color:'#E51B15'
			},
			{
				main:'assets/ball_a_2.png',
				collect:'assets/ball_a_2c.png',
				trail:'assets/ball_a_2t.png',
				color:'#34B909'
			},
			{
				main:'assets/ball_a_3.png',
				collect:'assets/ball_a_3c.png',
				trail:'assets/ball_a_3t.png',
				color:'#AA40DB'
			},
			{
				main:'assets/ball_a_4.png',
				collect:'assets/ball_a_4c.png',
				trail:'assets/ball_a_4t.png',
				color:'#338DDB'
			},
			{
				main:'assets/ball_a_5.png',
				collect:'assets/ball_a_5c.png',
				trail:'assets/ball_a_5t.png',
				color:'#F9A50F'
			},
			{
				main:'assets/ball_a_6.png',
				collect:'assets/ball_a_6c.png',
				trail:'assets/ball_a_6t.png',
				color:'#F8CA1C'
			},
		]
	},
	{
		balls:[
			{
				main:'assets/ball_b_1.png',
				collect:'assets/ball_b_1c.png',
				trail:'assets/ball_b_1t.png',
				color:'#E51B15'
			},
			{
				main:'assets/ball_b_2.png',
				collect:'assets/ball_b_2c.png',
				trail:'assets/ball_b_2t.png',
				color:'#34B909'
			},
			{
				main:'assets/ball_b_3.png',
				collect:'assets/ball_b_3c.png',
				trail:'assets/ball_b_3t.png',
				color:'#AA40DB'
			},
			{
				main:'assets/ball_b_4.png',
				collect:'assets/ball_b_4c.png',
				trail:'assets/ball_b_4t.png',
				color:'#338DDB'
			},
			{
				main:'assets/ball_b_5.png',
				collect:'assets/ball_b_5c.png',
				trail:'assets/ball_b_5t.png',
				color:'#F9A50F'
			},
			{
				main:'assets/ball_b_6.png',
				collect:'assets/ball_b_6c.png',
				trail:'assets/ball_b_6t.png',
				color:'#F8CA1C'
			},
		]
	},
	{
		balls:[
			{
				main:'assets/ball_c_1.png',
				collect:'assets/ball_c_1c.png',
				trail:'assets/ball_c_1t.png',
				color:'#E51B15'
			},
			{
				main:'assets/ball_c_2.png',
				collect:'assets/ball_c_2c.png',
				trail:'assets/ball_c_2t.png',
				color:'#34B909'
			},
			{
				main:'assets/ball_c_3.png',
				collect:'assets/ball_c_3c.png',
				trail:'assets/ball_c_3t.png',
				color:'#AA40DB'
			},
			{
				main:'assets/ball_c_4.png',
				collect:'assets/ball_c_4c.png',
				trail:'assets/ball_c_4t.png',
				color:'#338DDB'
			},
			{
				main:'assets/ball_c_5.png',
				collect:'assets/ball_c_5c.png',
				trail:'assets/ball_c_5t.png',
				color:'#F9A50F'
			},
			{
				main:'assets/ball_c_6.png',
				collect:'assets/ball_c_6c.png',
				trail:'assets/ball_c_6t.png',
				color:'#F8CA1C'
			},
		]
	},
	{
		balls:[
			{
				main:'assets/ball_d_1.png',
				collect:'assets/ball_d_1c.png',
				trail:'assets/ball_d_1t.png',
				color:'#E51B15'
			},
			{
				main:'assets/ball_d_2.png',
				collect:'assets/ball_d_2c.png',
				trail:'assets/ball_d_2t.png',
				color:'#34B909'
			},
			{
				main:'assets/ball_d_3.png',
				collect:'assets/ball_d_3c.png',
				trail:'assets/ball_d_3t.png',
				color:'#AA40DB'
			},
			{
				main:'assets/ball_d_4.png',
				collect:'assets/ball_d_4c.png',
				trail:'assets/ball_d_4t.png',
				color:'#338DDB'
			},
			{
				main:'assets/ball_d_5.png',
				collect:'assets/ball_d_5c.png',
				trail:'assets/ball_d_5t.png',
				color:'#F9A50F'
			},
			{
				main:'assets/ball_d_6.png',
				collect:'assets/ball_d_6c.png',
				trail:'assets/ball_d_6t.png',
				color:'#F8CA1C'
			},
		]
	}
];

const themeSettings = [
	{
		fog:'#74B3CE',
		pathLight:{road:'#0E1F23', rumble:'#000', lane:'#0E1F23'},
		pathDark:{road:'#0B1A1E', rumble:'#000'},
		background:'assets/background_1.png',
		backgroundShapes:'assets/backgroundshapes_1.png',
	},
	{
		fog:'#FFE093',
		pathLight:{road:'#0E1F23', rumble:'#000', lane:'#0E1F23'},
		pathDark:{road:'#0B1A1E', rumble:'#000'},
		background:'assets/background_2.png',
		backgroundShapes:'assets/backgroundshapes_2.png',
	},
	{
		fog:'#77F2A8',
		pathLight:{road:'#0E1F23', rumble:'#000', lane:'#0E1F23'},
		pathDark:{road:'#0B1A1E', rumble:'#000'},
		background:'assets/background_3.png',
		backgroundShapes:'assets/backgroundshapes_3.png',
	}
]

//game settings
const gameSettings = {
	fogDensity:3,
	keyboard:{ //keyboard code
		left:[37,65],
		right:[39,68],
	},
};

//game text display
const textStrings = {
	instructionDesktop:"TAP LEFT RIGHT OR\nPRESS ARROW KEY TO MOVE",
	instructionMobile:"TAP LEFT RIGHT TO MOVE",
	miles:' MILES',
	gameOver:'GAME OVER',
	exitTitle:'EXIT GAME',
	exitMessage:'ARE YOU SURE\nYOU WANT TO\nQUIT GAME?',
	share:'SHARE YOUR SCORE:',
	resultTitle:'YOU SCORE',
}

//Social share, [SCORE] will replace with game score
const shareSettings = {
	enable:true,
	options:['facebook','twitter','whatsapp','telegram','reddit','linkedin'],
	shareTitle:'Highscore on Color Rush is [SCORE]PTS',
	shareText:'[SCORE]PTS is mine new highscore on Color Rush game! Try it now!',
	customScore:true, //share a custom score to Facebook, it use customize share.php (Facebook and PHP only)
	gtag:true //Google Tag
}

/*!
 *
 * GAME SETTING CUSTOMIZATION END
 *
 */

$.editor = {enable:false};
const playerData = {score:0};
const gameData = {paused:true, themes:[], themesShuffleIndex:0, themeIndex:0, balls:[], ballsShuffleIndex:0, ballIndex:0, ball:{shuffle:[], shuffleIndex:0, index:0, dir:0, w:100, x:0, y:0, z:0, offsetX:0, spriteX:0, lastX:0}, explodes:[], distanceDivide:50};
const tweenData = {score:0, tweenScore:0};
const gravityData = {animate:false, total:30, totalScore:6, gravity:1, drag:.99, range:100};
const build_id = 0x326D7;
const cerify_key = 'AcKzL3cDADnzUN-0kubRNtyGdbE';

var dt;
const defaultData = {
	width:0,
	height:0,
	scale:0.00205,
	viewport:{landscape:{w:1280, h:768, scale:0.00205}, portrait:{w:768, h:800, scale:0.00205}},
	extraHeight:1000,
	centrifugal:.3,
	segmentLength:150,
	trackLength:null,
	fieldOfView:100,
	cameraHeight:800,
	cameraDepth:null,
	drawDistance:150,
	shapesSpeed:30,
	playerX:0,
	playerZ:0,
	position:0,
	speed:0,
	maxSpeed:0,
	maxSpeedUpdate:0,
	accel:0,
	decel:0,
	lastY:0,
	currentLapTime:0
};
var segments = [];

/*!
 * 
 * GAME BUTTONS - This is the function that runs to setup button event
 * 
 */
function buildGameButton(){
	$(window).focus(function() {
		if(!buttonSoundOn.visible){
			toggleSoundInMute(false);
		}

		if (typeof buttonMusicOn != "undefined") {
			if(!buttonMusicOn.visible){
				toggleMusicInMute(false);
			}
		}
	});
	
	$(window).blur(function() {
		if(!buttonSoundOn.visible){
			toggleSoundInMute(true);
		}

		if (typeof buttonMusicOn != "undefined") {
			if(!buttonMusicOn.visible){
				toggleMusicInMute(true);
			}
		}
	});
	
	if(isDesktop){
		var isInIframe = (window.location != window.parent.location) ? true : false;
		if(isInIframe){
			this.document.onkeydown = keydown;
			this.document.onkeyup = keyup;
		
			$(window).blur(function() {
				appendFocusFrame();
			});
			appendFocusFrame();
        }else{
            this.document.onkeydown = keydown;
			this.document.onkeyup = keyup;
        }
	}

	if(audioOn){
		if(muteSoundOn){
			toggleSoundMute(true);
		}
		if(muteMusicOn){
			toggleMusicMute(true);
		}
	}

	buttonStart.cursor = "pointer";
	buttonStart.addEventListener("click", function(evt) {
		playSound('soundButton');
		goPage('game');
	});
	
	itemExit.addEventListener("click", function(evt) {
	});

	if(shareSettings.enable){
		buttonShare.cursor = "pointer";
		buttonShare.addEventListener("click", function(evt) {
			playSound('soundButton');
			toggleSocialShare(true);
		});

		for(let n=0; n<shareSettings.options.length; n++){
			$.share['button'+n].cursor = "pointer";
			$.share['button'+n].addEventListener("click", function(evt) {
				shareLinks(evt.target.shareOption, addCommas(playerData.score));
			});
		}
	}
	
	buttonContinue.cursor = "pointer";
	buttonContinue.addEventListener("click", function(evt) {
		playSound('soundButton');
		getThemeIndex();
		getBallIndex();
		goPage('main');
	});
	
	
	buttonSoundOff.cursor = "pointer";
	buttonSoundOff.addEventListener("click", function(evt) {
		toggleSoundMute(true);
	});
	
	buttonSoundOn.cursor = "pointer";
	buttonSoundOn.addEventListener("click", function(evt) {
		toggleSoundMute(false);
	});

	if (typeof buttonMusicOff != "undefined") {
		buttonMusicOff.cursor = "pointer";
		buttonMusicOff.addEventListener("click", function(evt) {
			toggleMusicMute(true);
		});
	}
	
	if (typeof buttonMusicOn != "undefined") {
		buttonMusicOn.cursor = "pointer";
		buttonMusicOn.addEventListener("click", function(evt) {
			toggleMusicMute(false);
		});
	}
	
	buttonFullscreen.cursor = "pointer";
	buttonFullscreen.addEventListener("click", function(evt) {
		toggleFullScreen();
	});
	
	buttonExit.cursor = "pointer";
	buttonExit.addEventListener("click", function(evt) {
		if (window.__arcadeColorMatch && window.__arcadeColorMatch()) return; togglePop(true);
		toggleOptions(false);
	});
	
	buttonSettings.cursor = "pointer";
	buttonSettings.addEventListener("click", function(evt) {
		toggleOptions();
	});
	
	buttonConfirm.cursor = "pointer";
	buttonConfirm.addEventListener("click", function(evt) {
		playSound('soundButton');
		togglePop(false);
		
		if (window.__arcadeColorMatch && window.__arcadeColorMatch()) return;
		stopGame();
		goPage('main');
	});
	
	buttonCancel.cursor = "pointer";
	buttonCancel.addEventListener("click", function(evt) {
		playSound('soundButton');
		togglePop(false);
	});

	window.addEventListener('blur', function() {
		toggleGamePause(true);
	}, false);
 
 
	window.addEventListener('focus', function() {
		toggleGamePause(false);
	}, false);

	touchScreen.addEventListener("click", function(evt) {
		if(stage.mouseX / dpr < canvasW/2){
			actionDirection('left');
		}else{
			actionDirection('right');
		}
	});

	for(var n=0; n<themeSettings.length; n++){
		gameData.themes.push(n);
	}
	shuffle(gameData.themes);
	for(var n=0; n<ballsSettings.length; n++){
		gameData.balls.push(n);
	}
	shuffle(gameData.balls);
	getThemeIndex();
	getBallIndex();
	preventScrolling();
}

function preventScrolling(){
	const inIframe = window.self !== window.top;
	if(inIframe){
		var keys = [37,65,39,68,38,87,40,83];
		$(window).on( "keydown", function(event) {
		if(keys.indexOf(event.keyCode) != -1){
			event.preventDefault();
		}
		});
	}
}

function appendFocusFrame(){
	$('#mainHolder').prepend('<div id="focus" style="position:absolute; width:100%; height:100%; z-index:1000;"></div');
	$('#focus').click(function(){
		$('#focus').remove();
	});	
}

/*!
 * 
 * KEYBOARD EVENTS - This is the function that runs for keyboard events
 * 
 */
function keydown(event) {
	if(curPage == "game"){
		if(gameSettings.keyboard.left.indexOf(event.keyCode) != -1){
			actionDirection('left');
		}else if(gameSettings.keyboard.right.indexOf(event.keyCode) != -1){
			actionDirection('right');
		}
	}
}
 
function keyup(event) {

}

/*!
 * 
 * TOGGLE SOCIAL SHARE - This is the function that runs to toggle social share
 * 
 */
function toggleSocialShare(con){
	if(!shareSettings.enable){return;}
	buttonShare.visible = con == true ? false : true;
	shareSaveContainer.visible = con == true ? false : true;
	socialContainer.visible = con;

	if(con){
		if (typeof buttonSave !== 'undefined') {
			TweenMax.to(buttonShare, 3, {overwrite:true, onComplete:toggleSocialShare, onCompleteParams:[false]});
		}
	}
}

function positionShareButtons(){
	if(!shareSettings.enable){return;}
	if (typeof buttonShare !== 'undefined') {
		if (typeof buttonSave !== 'undefined') {
			if(buttonSave.visible){
				buttonShare.x = -((buttonShare.image.naturalWidth/2) + 5);
				buttonSave.x = ((buttonShare.image.naturalWidth/2) + 5);
			}else{
				buttonShare.x = 0;
			}
		}
	}
}

/*!
 * 
 * TOGGLE POP - This is the function that runs to toggle popup overlay
 * 
 */
function togglePop(con){
	exitContainer.visible = con;
	toggleGamePause(con);
}


/*!
 * 
 * DISPLAY PAGES - This is the function that runs to display pages
 * 
 */
var curPage=''
function goPage(page){
	curPage=page;
	
	mainContainer.visible = false;
	gameContainer.visible = false;
	resultContainer.visible = false;
	togglePop(false);
	toggleOptions(false);
	
	var targetContainer = null;
	switch(page){
		case 'main':
			targetContainer = mainContainer;
			stopMusicLoop('musicGame');
			playMusicLoop('musicMain');
			prepareMainLoop();
		break;
		
		case 'game':
			targetContainer = gameContainer;
			stopMusicLoop('musicMain');
			playMusicLoop('musicGame');
			startGame();
		break;
		
		case 'result':
			targetContainer = resultContainer;
			stopGame();			
			playSound('soundResult');
			toggleSocialShare(false);

			resultDistanceTxt.text = addCommas(Math.floor(playerData.distance/gameData.distanceDivide)) + textStrings.miles;
			
			tweenData.tweenScore = 0;
			TweenMax.to(tweenData, .5, {tweenScore:playerData.score, overwrite:true, onUpdate:function(){
				resultDescTxt.text = addCommas(Math.floor(tweenData.tweenScore));
			}});
			
			saveGame(playerData.score);
		break;
	}
	
	if(targetContainer != null){
		targetContainer.visible = true;
		targetContainer.alpha = 0;
		TweenMax.to(targetContainer, .5, {alpha:1, overwrite:true});
	}
	
	resizeCanvas();
}

/*!
 * 
 * START GAME - This is the function that runs to start game
 * 
 */
function startGame(){
	gameData.paused = setGameLaunch();
	if (window.__arcadeColorStart) window.__arcadeColorStart();

	playerData.distance = 0;
	playerData.score = 0;
	statusContainer.alpha = 0;
	if(!isDesktop){
		gameInstructionTxt.text = gameInstructionShadowTxt.text = textStrings.instructionMobile;
	}else{
		gameInstructionTxt.text = gameInstructionShadowTxt.text = textStrings.instructionDesktop;
	}
	toggleInstruction(true);
	updateGameScore();

	gameData.over = false;
	gameData.action = true;
	gameData.nextAction = '';
	gameData.levelNum = 0;
	gameData.explodes = [];

	gameData.ball.shuffle = [];
	gameData.ball.shuffleIndex = 0;
	for(var n=0; n<ballsSettings[gameData.ballIndex].balls.length; n++){
		gameData.ball.shuffle.push(n);
	}
	shuffle(gameData.ball.shuffle);

	prepareLevel();
	prepareWorld();
	resizeGame();
}

function toggleInstruction(con){
	if(con){
		animateInstruction(instructionContainer);
	}else{
		TweenMax.killTweensOf(instructionContainer);
		instructionContainer.alpha = 0;
	}
}

function animateInstruction(obj){
	obj.alpha = .8;
	var tweenSpeed = .3;
	TweenMax.to(obj, tweenSpeed, {alpha:.5, overwrite:true, onComplete:function(){
		TweenMax.to(obj, tweenSpeed, {alpha:.8, overwrite:true, onComplete:animateInstruction, onCompleteParams:[obj]});
	}});
}

function resizeGame(){
	bgWorldContainer.x = canvasW/2;
	bgWorldContainer.y = canvasH/2;

	touchScreen.x = canvasW/2;
	touchScreen.y = canvasH/2;

	scoreContainer.x = canvasW/2;
	scoreContainer.y = canvasH/100 * 30;

	statusContainer.x = canvasW/2;
	statusContainer.y = canvasH/100 * 45;

	if(viewport.isLandscape){
		instructionContainer.x = canvasW/2;
		instructionContainer.y = canvasH/100 * 60;
	}else{
		instructionContainer.x = canvasW/2;
		instructionContainer.y = canvasH/100 * 60;
	}

	if(viewport.isLandscape){
		gameData.ball.z = 7;
	}else{
		gameData.ball.z = 4;
	}
	defaultData.playerZ = (gameData.ball.z * defaultData.segmentLength) + (defaultData.segmentLength/2);
}

/*!
 * 
 * GET THEME INDEX - This is the function that runs to get theme index
 * 
 */
function getThemeIndex(){
	gameData.themeIndex = gameData.themes[gameData.themesShuffleIndex];
	gameData.themesShuffleIndex++;
	if(gameData.themesShuffleIndex > gameData.themes.length-1){
		gameData.themesShuffleIndex = 0;
		shuffle(gameData.themes);
	}
}

function getBallIndex(){
	gameData.ballIndex = gameData.balls[gameData.ballsShuffleIndex];
	gameData.ballsShuffleIndex++;
	if(gameData.ballsShuffleIndex > gameData.balls.length-1){
		gameData.ballsShuffleIndex = 0;
		shuffle(gameData.balls);
	}
}

 /*!
 * 
 * STOP GAME - This is the function that runs to stop play game
 * 
 */
function stopGame(){	
	gameData.paused = true;
	TweenMax.killAll(false, true, false);
}

function saveGame(score){
	if ( typeof toggleScoreboardSave == 'function' ) { 
		$.scoreData.score = score;
		if(typeof type != 'undefined'){
			$.scoreData.type = type;	
		}
		toggleScoreboardSave(true);
	}

	/*$.ajax({
      type: "POST",
      url: 'saveResults.php',
      data: {score:score},
      success: function (result) {
          console.log(result);
      }
    });*/
}

/*!
 * 
 * PREPARE MAIN LOOP - This is the function that runs to prepare main loop
 * 
 */
function prepareMainLoop(){
	gameData.over = false;
	prepareLevel();
	prepareWorld();
	resizeGame();
}

/*!
 * 
 * ACTION GAME - This is the function that runs for game action
 * 
 */
function actionDirection(dir){
	if(!gameData.action){
		if(gameData.nextAction == ''){
			gameData.nextAction = dir;
		}
		return;
	}

	toggleInstruction(false);
	playSound('soundMove');
	if(dir == 'left'){
		gameData.ball.dir--;
		gameData.ball.dir = gameData.ball.dir < -1 ? -1 : gameData.ball.dir;
	}else{
		gameData.ball.dir++;
		gameData.ball.dir = gameData.ball.dir > 1 ? 1 : gameData.ball.dir;
	}
}

/*!
 * 
 * PREPARE LEVEL - This is the function that runs prepare level
 * 
 */
function prepareLevel(){
	gameData.levelMax = 6;
	gameData.level = {
		play:true,
		moveSpeed:.2,
		moveSlideSpeed:[1],
		pathWidth:300,
		pathRumbleLength:2,
		pathLanes:3,
		fogDensity:gameSettings.fogDensity,
		speed:0,
		accel:10*100,
		decel:-(70*100),
		maxSpeed:50*100,
		maxSpeedUpdate:200*100,
		colorFog:themeSettings[gameData.themeIndex].fog,
		colorLight:themeSettings[gameData.themeIndex].pathLight,
		colorDark:themeSettings[gameData.themeIndex].pathDark,
		pathType:[],
		ballsInsertData:[],
		ballsInsertType:[],
		straight:{none:0, short:25, medium:50, long:100},
		hill:{none:0, low:20, medium:40, high:60},
		curve:{none:0, easy:2, medium:4, hard:6},
		bumps:{length:10, total:[2,5], height:[4,8]},
	}
	
	if(curPage == 'main'){
		gameData.level.play = false;
		gameData.level.ballsInsertData = [20,20,3,2];
		gameData.level.ballsInsertType = [1,2];
		gameData.level.pathType = ['curve','curve','hill']
	}else if(gameData.levelNum == 0){
		gameData.level.moveSlideSpeed = [1,.5];
		gameData.level.maxSpeed = 50*100;
		gameData.level.pathType = ['curve','bumps'];
		gameData.level.ballsInsertData = [19,19,3,2];
		gameData.level.ballsInsertType = [1,2];
	}else if(gameData.levelNum == 1){
		gameData.level.moveSlideSpeed = [.3,.6];
		gameData.level.maxSpeed = 55*100;
		gameData.level.pathType = ['curve','bumps','hill'];
		gameData.level.ballsInsertData = [17,17,3,2];
		gameData.level.ballsInsertType = [1,2];
	}else if(gameData.levelNum == 2){
		gameData.level.moveSlideSpeed = [.3,.6];
		gameData.level.maxSpeed = 60*100;
		gameData.level.pathType = ['curve','bumps','hill'];
		gameData.level.ballsInsertData = [15,15,4,2];
		gameData.level.ballsInsertType = [0,1,2];
	}else if(gameData.levelNum == 3){
		gameData.level.moveSlideSpeed = [.3,.6];
		gameData.level.maxSpeed = 65*100;
		gameData.level.pathType = ['curve','bumps','hill'];
		gameData.level.ballsInsertData = [13,13,4,2];
		gameData.level.ballsInsertType = [0,1,2];
	}else if(gameData.levelNum == 4){
		gameData.level.moveSlideSpeed = [.2,.4];
		gameData.level.maxSpeed = 70*100;
		gameData.level.pathType = ['sCurves','hill','rollingHills'];
		gameData.level.ballsInsertData = [11,11,5,2];
		gameData.level.ballsInsertType = [0,1,2,3];
	}else if(gameData.levelNum == 5){
		gameData.level.moveSlideSpeed = [.2,.4];
		gameData.level.maxSpeed = 80*100;
		gameData.level.pathType = ['curve','bumps','straight','hill','rollingHills','sCurves'];
		gameData.level.ballsInsertData = [10,10,5,2];
		gameData.level.ballsInsertType = [0,1,2,3];
	}else if(gameData.levelNum == 5){
		gameData.level.moveSlideSpeed = [.2,.4];
		gameData.level.maxSpeed = 80*100;
		gameData.level.pathType = ['curve','bumps','straight','hill','rollingHills','sCurves'];
		gameData.level.ballsInsertData = [8,8,6,3];
		gameData.level.ballsInsertType = [0,1,2,3];
	}
	shuffle(gameData.level.pathType);
}

function proceedNextLevel(){
	gameData.levelNum++;
	gameData.levelNum = gameData.levelNum > gameData.levelMax ? gameData.levelMax : gameData.levelNum;
	prepareLevel();
	preparePath();
}

/*!
 * 
 * PREPARE WORLD - This is the function that runs to prepare world
 * 
 */
function prepareWorld(){
	bgWorldContainer.removeAllChildren();
	particlesContainer.removeAllChildren();
	explodeContainer.removeAllChildren();

	gameData.bgGame = new createjs.Bitmap(loader.getResult('background'+gameData.themeIndex));
	centerReg(gameData.bgGame);
	gameData.bgGameShape = new createjs.Bitmap(loader.getResult('backgroundShapes'+gameData.themeIndex));
	centerReg(gameData.bgGameShape);
	bgWorldContainer.addChild(gameData.bgGame, gameData.bgGameShape);

	defaultData.speed = gameData.level.speed;
	defaultData.maxSpeed = gameData.level.maxSpeed;
	defaultData.maxSpeedUpdate = gameData.level.maxSpeedUpdate;
	defaultData.accel = gameData.level.accel;
	defaultData.decel = gameData.level.decel;
	defaultData.cameraDepth = 1 / Math.tan((defaultData.fieldOfView/2) * Math.PI/180);
	defaultData.playerZ = (gameData.ball.z * defaultData.segmentLength) + (defaultData.segmentLength/2);

	gameData.ball.dir = 0;
	gameData.ball.x = 0;
	gameData.ball.y = 0;
	gameData.ball.disX = gameData.level.pathWidth/470;
	gameData.ball.loopDisX = gameData.level.pathWidth/550;
	gameData.ball.offsetX = 0;
	gameData.ball.spriteX = canvasW/2;
	gameData.ball.lastX = 0;

	preparePath();	
}

function preparePath(){
	playSound('soundStart');
	defaultData.speed = defaultData.maxSpeedUpdate;

	if(curPage == 'game'){
		gameData.ball.index = gameData.ball.shuffle[gameData.ball.shuffleIndex];
		gameData.ball.shuffleIndex++;
		if(gameData.ball.shuffleIndex > gameData.ball.shuffle.length-1){
			gameData.ball.shuffleIndex = 0;
			shuffle(gameData.ball.shuffle);
		}
	}

	var insertParticles = false;
	var storeParticlesArr = [];
	if(segments.length > 0){
		insertParticles = true;
		for(var n=defaultData.segmentReset-gameData.ball.z; n<defaultData.segmentReset; n++){
			storeParticlesArr.push(segments[n].particles);
		}
	}

	segments = [];
	defaultData.position = 0;
	defaultData.currentLapTime = 0;

	addRoadType('straight', gameData.level.straight.long);
	if(insertParticles){
		for(var n=0; n<gameData.ball.z; n++){
			segments[n].particles = storeParticlesArr[n];
		}
	}

	for(var n=0; n<gameData.level.pathType.length; n++){
		if(gameData.level.pathType[n] == 'straight'){
			addRoadType(gameData.level.pathType[n]);
		}else if(gameData.level.pathType[n] == 'bumps'){
			addRoadType(gameData.level.pathType[n], gameData.level.bumps.length);
		}else if(gameData.level.pathType[n] == 'curve'){
			var curveHillArr = [gameData.level.hill.low, -gameData.level.hill.low];
			var curveArr = [gameData.level.curve.medium, -gameData.level.curve.medium];
			shuffle(curveHillArr);
			shuffle(curveArr);
			addRoadType(gameData.level.pathType[n], gameData.level.straight.medium, curveHillArr[0], curveArr[0]);
		}else if(gameData.level.pathType[n] == 'hill'){
			var curveHillArr = [gameData.level.hill.low, -gameData.level.hill.low, gameData.level.hill.medium, -gameData.level.hill.medium, gameData.level.hill.high, -gameData.level.hill.high];
			shuffle(curveHillArr);
			addRoadType(gameData.level.pathType[n], gameData.level.straight.medium, curveHillArr[0]);
		}else if(gameData.level.pathType[n] == 'rollingHills'){
			addRoadType(gameData.level.pathType[n]);
		}
	}
	defaultData.segmentReset = segments.length;

	var ballInsertData = {
		total:defaultData.segmentReset-defaultData.drawDistance,
		countInsert:gameData.level.ballsInsertData[0],
		countInsertMax:gameData.level.ballsInsertData[0],
		countBreak:0,
		countBreakMax:gameData.level.ballsInsertData[1],
		countLoop:0,
		countLoopMax:gameData.level.ballsInsertData[2],
		countScoreArr:[],
		typeIndex:0
	};
	ballInsertData.countBreak = ballInsertData.countBreakMax;
	shuffle(gameData.level.ballsInsertType);

	for(var n=0; n<gameData.level.ballsInsertData[2] ; n++) {
		if(n < gameData.level.ballsInsertData[3]){
			ballInsertData.countScoreArr.push(true);
		}else{
			ballInsertData.countScoreArr.push(false);
		}
	}

	for(var n=defaultData.drawDistance; n<segments.length ; n++) {
		if(ballInsertData.countInsert >= ballInsertData.countInsertMax){
			addSegmentBalls(n,gameData.level.ballsInsertType[ballInsertData.typeIndex],ballInsertData.countScoreArr[ballInsertData.countLoop]);
			ballInsertData.typeIndex++;
			if(ballInsertData.typeIndex > gameData.level.ballsInsertType.length-1){
				ballInsertData.typeIndex = 0;
				shuffle(gameData.level.ballsInsertType);
			}

			ballInsertData.countInsert = 0;
			ballInsertData.countLoop++;
			if(ballInsertData.countLoop >= ballInsertData.countLoopMax){
				shuffle(ballInsertData.countScoreArr);
				ballInsertData.countLoop = 0;
				ballInsertData.countBreak = 0;
			}
		}
		if(ballInsertData.countBreak >= ballInsertData.countBreakMax){
			ballInsertData.countInsert++;
		}else{
			ballInsertData.countBreak++;
		}
	}

	addRoadType('straight', gameData.level.straight.long);
	addRoadType('end');
	defaultData.trackLength = segments.length * defaultData.segmentLength;
}

function addSegmentBalls(z,type,score){
	var moveBall = false;
	var totalBalls = 1;
	var positionsArr = [0, gameData.ball.loopDisX, -gameData.ball.loopDisX];
	var ballsArr = [];
	
	if(type == 0){
		moveBall = true;
		positionsArr = [gameData.ball.loopDisX, -gameData.ball.loopDisX];
	}else if(type == 2){
		totalBalls = 2;
	}else if(type == 3){
		totalBalls = 3;
		score = true;
	}
	shuffle(positionsArr);

	for(var b=0; b<ballsSettings[gameData.ballIndex].balls.length; b++){
		if(gameData.ball.index != b){
			ballsArr.push(b);
		}
	}
	shuffle(ballsArr);

	if(score){
		if(totalBalls == 1){
			ballsArr.length = 0;
		}else{
			ballsArr.length = totalBalls-1;
		}
		ballsArr.push(gameData.ball.index);
		shuffle(ballsArr);
	}else{
		ballsArr.length = totalBalls;
	}

	for(var n=0; n<totalBalls; n++){
		var ballIndex = ballsArr[n];
		var ballSprite = {
			index:ballIndex,
			id:'ballCollect'+gameData.ballIndex+'_'+ballIndex,
			w:$.sprites['ballCollect'+gameData.ballIndex+'_'+ballIndex].image.naturalWidth/2,
			h:$.sprites['ballCollect'+gameData.ballIndex+'_'+ballIndex].image.naturalHeight/2,
			moveBall:moveBall,
			movePositions:positionsArr,
			moveIndex:0,
		}
		addSprite(z, ballSprite, positionsArr[n]);
	}
}

/*!
 * 
 * ADD WORLD ELEMENTS - This is the function that runs to add world elements
 * 
 */
function addSegment(curve, y) {
  var n = segments.length;
  segments.push({
	  index: n,
		 p1: { world: { y: getLastY(), z:  n   *defaultData.segmentLength }, camera: {}, screen: {} },
		 p2: { world: { y: y,       z: (n+1)*defaultData.segmentLength }, camera: {}, screen: {} },
	  curve: curve,
	  balls: [],
	  particles: [],
	  color: Math.floor(n/gameData.level.pathRumbleLength)%2 ? gameData.level.colorDark : gameData.level.colorLight
  });
}

function addSprite(n, sprite, offset) {
	segments[n].balls.push({ source: sprite, offset: offset, active:true});
}

function addParticle(n, sprite, offset) {
	segments[n].particles.push({ source: sprite, offset: offset, active:true});
}

function addRoad(enter, hold, leave, curve, y) {
	var startY   = getLastY();
	var endY     = startY + (toInt(y, 0) * defaultData.segmentLength);
	var n, total = enter + hold + leave;
	for(var n = 0 ; n < enter ; n++)
		addSegment(easeIn(0, curve, n/enter), easeInOut(startY, endY, n/total));
	for(var n = 0 ; n < hold  ; n++)
		addSegment(curve, easeInOut(startY, endY, (enter+n)/total));
	for(var n = 0 ; n < leave ; n++)
		addSegment(easeInOut(curve, 0, n/leave), easeInOut(startY, endY, (enter+hold+n)/total));
}

function addRoadType(type, num, height, curve){
	switch(type){
		case 'straight':
			num = num || gameData.level.straight.short;
			addRoad(num, num, num, 0, 0);
		break;
		
		case 'hill':
			num    = num    || gameData.level.straight.medium;
  			height = height || gameData.level.hill.medium;
  			curve = curve || gameData.level.curve.none;
			addRoad(num, num, num, curve, height);
		break;
		
		case 'curve':
			num    = num    || gameData.level.straight.medium;
			curve  = curve  || gameData.level.curve.medium;
			height = height || gameData.level.hill.none;
			addRoad(num, num, num, curve, height);
		break;
		
		case 'rollingHills':
			num    = num    || gameData.level.straight.short;
			height = height || gameData.level.hill.low;
			var curveArr = [];
			if(randomBoolean()){
				curveArr.push(gameData.level.curve.easy);
				curveArr.push(-gameData.level.curve.easy);
			}else{
				curveArr.push(-gameData.level.curve.easy);
				curveArr.push(gameData.level.curve.easy);
			}
			addRoad(num, num, num,  0,                height/2);
			addRoad(num, num, num,  0,               -height);
			addRoad(num, num, num,  curveArr[0],  	height);
			addRoad(num, num, num,  0,                0);
			addRoad(num, num, num,  curveArr[1],  height/2);
			addRoad(num, num, num,  0,                0);
		break;
		
		case 'sCurves':
			num    = num    || gameData.level.straight.medium;
			var totalCurve = randomIntFromInterval(4,6);
			var hillsArr = [gameData.level.hill.low, gameData.level.hill.medium];
			var curvesArr = [gameData.level.curve.easy, gameData.level.curve.medium];
			var curveNum = randomBoolean() == true ? curvesArr[0] : -curvesArr[0];
			addRoad(num, num, num, curveNum, gameData.level.hill.none);
			for(var n=0; n<totalCurve; n++){
				shuffle(hillsArr);
				shuffle(curvesArr);
				var curveNum = randomBoolean() == true ? curvesArr[0] : -curvesArr[0];
				addRoad(num, num, num, curveNum, hillsArr[0]);
			}
		break;
		
		case 'bumps':
			num    = num    || gameData.level.length.short;
			var totalBumps = randomIntFromInterval(gameData.level.bumps.total[0],gameData.level.bumps.total[1]);
			for(var n=0; n<totalBumps; n++){
				var bumpHeight = randomIntFromInterval(gameData.level.bumps.height[0],gameData.level.bumps.height[1]);
				bumpHeight = !isEven(n) ? bumpHeight : -bumpHeight;
				addRoad(num, num, num, 0,  bumpHeight);
			}
		break;
		
		case 'end':
			num = num || 50;
			var curvesArr = [gameData.level.curve.none, gameData.level.curve.easy, gameData.level.curve.medium];
			var curveNum = randomBoolean() == true ? curvesArr[0] : -curvesArr[0];
  			addRoad(num, num, num, curveNum, -getLastY()/defaultData.segmentLength);
		break;
	}
}

function getLastY() {
	return (segments.length == 0) ? 0 : segments[segments.length-1].p2.world.y;
}

/*!
 * 
 * UPDATE WORLD - This is the function that runs to update world
 * 
 */
function updateWorld(){
	updateSprites();
	// renderWorld() moved out of the fixed-step loop: it is now called ONCE per
	// rendered frame from canvas.js tick(). It rebuilds the entire road display
	// list (~150 segments x new Shape/clone each) so running it inside catch-up
	// steps did up to 4 full rebuilds per frame on a lagging device.
}

function updateSprites() {
	var n, sprite, spriteW;
	var dt = (1/60);
	var playerSegment = findSegment((defaultData.position+defaultData.playerZ));
	var playerW = gameData.ball.w * defaultData.scale;
	var startPosition = defaultData.position;
	
	defaultData.position = getIncrease(defaultData.position, dt * defaultData.speed, defaultData.trackLength);
	if(gameData.over){
		defaultData.speed = getAccelerate(defaultData.speed, defaultData.decel, dt);
	}else{
		defaultData.speed = getAccelerate(defaultData.speed, defaultData.accel, dt);
		playerData.distance = getAccelerate(playerData.distance, defaultData.accel, dt);
		updateGameScore();
	}

	var newPlayerX = 0;
	if(gameData.ball.dir == 1){
		newPlayerX = gameData.ball.disX;
	}else if(gameData.ball.dir == -1){
		newPlayerX = -gameData.ball.disX;
	}
	TweenMax.to(defaultData, gameData.level.moveSpeed, {playerX:newPlayerX, overwrite:true});
	
	//hit balls
	if(!gameData.over && gameData.level.play){
		for(n = 0 ; n < playerSegment.balls.length ; n++) {
			sprite  = playerSegment.balls[n];
			if(sprite.active){
				spriteW = sprite.source.w * defaultData.scale;
				if(getOverlap(defaultData.playerX, playerW*2, sprite.offset, spriteW*2)) {
					if(sprite.source.index == gameData.ball.index){
						sprite.active = false;
						var randomSound = Math.floor(Math.random()*3)+1;
						playSound('soundSuccess'+randomSound);
						startExplode(gameData.ball.x,gameData.ball.y,true);
						playerData.score++;
					}else{
						startExplode(gameData.ball.x,gameData.ball.y,false);
						endGame();
					}
				}	
			}
		}
	}

	var maxSpeed = viewport.isLandscape == true ? defaultData.maxSpeed : defaultData.maxSpeed * .8;
	if(playerSegment.index < 100){
		maxSpeed = defaultData.maxSpeedUpdate;
	}
	defaultData.speed = getLimit(defaultData.speed, 0, maxSpeed);

	var curveNum = playerSegment.curve < 0 ? Math.abs(playerSegment.curve) : -playerSegment.curve;
	gameData.bgGameShape.x = curveNum * defaultData.shapesSpeed;
	
	if (defaultData.position > defaultData.playerZ) {
		if (defaultData.currentLapTime && (startPosition < defaultData.playerZ)) {
			console.log('finish lap');
		}else {
			defaultData.currentLapTime += dt;
		}
	}
}

/*!
 * 
 * RENDER WORLD - This is the function that runs to update render world
 * 
 */
function renderWorld() {
	var baseSegment   = findSegment(defaultData.position);
	var basePercent   = percentRemaining(defaultData.position, defaultData.segmentLength);
	var playerSegment = findSegment(defaultData.position+defaultData.playerZ);
	var playerPercent = percentRemaining(defaultData.position+defaultData.playerZ, defaultData.segmentLength);
	var playerY       = getInterpolate(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent);
	var maxy          = defaultData.height+defaultData.extraHeight;
	
	var x  = 0;
	var dx = - (baseSegment.curve * basePercent);
	worldContainer.removeAllChildren();

  	var n, i, segment, sprite, spriteScale, spriteX, spriteY;
	for(n = 0 ; n < defaultData.drawDistance ; n++) {
		segment        = segments[(baseSegment.index + n) % segments.length];
		segment.looped = segment.index < baseSegment.index;
		segment.fog    = exponentialFog(n/defaultData.drawDistance, gameData.level.fogDensity);
		segment.clip   = maxy;
		
		getProject(segment.p1, (defaultData.playerX * gameData.level.pathWidth) - x,      playerY + defaultData.cameraHeight, defaultData.position - (segment.looped ? defaultData.trackLength : 0), defaultData.cameraDepth, defaultData.width, defaultData.height, gameData.level.pathWidth);
		getProject(segment.p2, (defaultData.playerX * gameData.level.pathWidth) - x - dx, playerY + defaultData.cameraHeight, defaultData.position - (segment.looped ? defaultData.trackLength : 0), defaultData.cameraDepth, defaultData.width, defaultData.height, gameData.level.pathWidth);
		
		x  = x + dx;
		dx = dx + segment.curve;
		
		if ((segment.p1.camera.z <= defaultData.cameraDepth)         || // behind us
			(segment.p2.screen.y >= segment.p1.screen.y) || // back face cull
			(segment.p2.screen.y >= maxy))                  // clip by (already rendered) hill
		  continue;
		
		defaultData.lastY = segment.p1.screen.y;
		renderSegment(defaultData.width, gameData.level.pathLanes,
					   segment.p1.screen.x,
					   segment.p1.screen.y,
					   segment.p1.screen.w,
					   segment.p2.screen.x,
					   segment.p2.screen.y,
					   segment.p2.screen.w,
					   segment.fog,
					   segment.color);
		
		maxy = segment.p1.screen.y;
	}
	
  	for(n = (defaultData.drawDistance-1) ; n > 0 ; n--) {
		segment = segments[(baseSegment.index + n) % segments.length];
		for(i = 0 ; i < segment.balls.length ; i++) {
			sprite      = segment.balls[i];
			spriteScale = segment.p1.screen.scale;
			spriteX     = segment.p1.screen.x + (spriteScale * sprite.offset * gameData.level.pathWidth * defaultData.width/2);
			spriteY     = segment.p1.screen.y;
			
			if(sprite.active){
				//update movement
				if(sprite.source.moveBall){
					if(Math.round(sprite.offset) == Math.round(sprite.source.movePositions[sprite.source.moveIndex])){
						sprite.source.moveIndex++;
						sprite.source.moveIndex = sprite.source.moveIndex > sprite.source.movePositions.length-1 ? 0 : sprite.source.moveIndex;
					}
					var moveSlideSpeed = gameData.level.moveSlideSpeed[Math.floor(Math.random()*gameData.level.moveSlideSpeed.length)];
					TweenMax.to(sprite, moveSlideSpeed, {offset:sprite.source.movePositions[sprite.source.moveIndex], ease:Linear.easeNone, overwrite:true});
				}

				renderSprite(defaultData.width, defaultData.height, gameData.level.pathWidth, sprite.source, spriteScale, spriteX, spriteY, sprite.offset, -1, segment.clip);
			}
		}

		if(segment == playerSegment && !gameData.over && gameData.level.play) {
			var offsetX = 0;
			if(gameData.ball.dir == 1){
				offsetX = gameData.ball.loopDisX;
			}else if(gameData.ball.dir == -1){
				offsetX = -gameData.ball.loopDisX;
			}
			
			spriteScale = segment.p1.screen.scale;
			spriteX = segment.p1.screen.x + (spriteScale * gameData.ball.offsetX * gameData.level.pathWidth * defaultData.width/2);
			TweenMax.to(gameData.ball, gameData.level.moveSpeed, {offsetX:offsetX, spriteX:spriteX, overwrite:true});
			renderBall(defaultData.width, defaultData.height, gameData.level.pathWidth,	defaultData.cameraDepth/defaultData.playerZ, gameData.ball.spriteX,
						(defaultData.height/2) - (defaultData.cameraDepth/defaultData.playerZ * getInterpolate(playerSegment.p1.camera.y, playerSegment.p2.camera.y, playerPercent) * defaultData.height/2),
						offsetX, -1, segment.clip);

			if(segment.particles.length == 0){
				var ballIndex = gameData.ball.index;
				var ballSprite = {
					index:ballIndex,
					id:'ballTrail'+gameData.ballIndex+'_'+ballIndex,
					w:$.sprites['ballTrail'+gameData.ballIndex+'_'+ballIndex].image.naturalWidth/2,
					h:$.sprites['ballTrail'+gameData.ballIndex+'_'+ballIndex].image.naturalHeight/2,
				}
				addParticle((baseSegment.index + n) % segments.length, ballSprite, gameData.ball.offsetX*1.13);
			}
		}

		for(i = 0 ; i < segment.particles.length ; i++) {
			sprite      = segment.particles[i];
			spriteScale = segment.p1.screen.scale;
			spriteX     = segment.p1.screen.x + (spriteScale * sprite.offset * gameData.level.pathWidth * defaultData.width/2);
			spriteY     = segment.p1.screen.y;
			
			if(sprite.active){
				renderParticle(defaultData.width, defaultData.height, gameData.level.pathWidth, sprite.source, spriteScale, spriteX, spriteY, sprite.offset, -1, segment.clip);
			}
		}
  	}

	if(baseSegment.index >= defaultData.segmentReset){
		proceedNextLevel();
	}
}

function findSegment(z) {
	return segments[Math.floor(z/defaultData.segmentLength) % segments.length]; 
}

/*!
 * 
 * RENDER MISC - This is the function that runs for render misc
 * 
 */
function renderPolygon(x1, y1, x2, y2, x3, y3, x4, y4, color){
	var shape = new createjs.Shape();
	shape.graphics.beginFill(color)
				.beginStroke()
				.moveTo(x1, y1)
				.lineTo(x2, y2)
				.lineTo(x3, y3)
				.lineTo(x4, y4)
				.endStroke();
	worldContainer.addChild(shape);
}

function renderSegment(width, lanes, x1, y1, w1, x2, y2, w2, fog, color){
	var r1 = rumbleWidth(w1, lanes),
        r2 = rumbleWidth(w2, lanes),
        l1 = laneMarkerWidth(w1, lanes),
        l2 = laneMarkerWidth(w2, lanes),
        lanew1, lanew2, lanex1, lanex2, lane;
    
    renderPolygon(x1-w1-r1, y1, x1-w1, y1, x2-w2, y2, x2-w2-r2, y2, color.rumble);
    renderPolygon(x1+w1+r1, y1, x1+w1, y1, x2+w2, y2, x2+w2+r2, y2, color.rumble);
    renderPolygon(x1-w1,    y1, x1+w1, y1, x2+w2, y2, x2-w2,    y2, color.road);
    
    if (color.lane) {
      lanew1 = w1*2/lanes;
      lanew2 = w2*2/lanes;
      lanex1 = x1 - w1 + lanew1;
      lanex2 = x2 - w2 + lanew2;
      for(lane = 1 ; lane < lanes ; lanex1 += lanew1, lanex2 += lanew2, lane++)
        renderPolygon(lanex1 - l1/2, y1, lanex1 + l1/2, y1, lanex2 + l2/2, y2, lanex2 - l2/2, y2, color.lane);
    }
    
    renderFog(x1-w1-r1, y1, (w2*2.4), y2-y1, fog);
}

function renderSprite(width, height, roadWidth, sprite, scale, destX, destY, offsetX, offsetY, clipY){
	var newSprite = $.sprites[sprite.id].clone();
    var destW  = (newSprite.image.naturalWidth * scale * width/2) * (defaultData.scale * roadWidth);
    var destH  = (newSprite.image.naturalHeight * scale * width/2) * (defaultData.scale * roadWidth);
    destX = destX + (destW * (offsetX || 0));
    destY = destY + (destH * (offsetY || 0));
	
    var clipH = clipY ? Math.max(0, destY+destH-clipY) : 0;
    if (clipH < destH){
		newSprite.x = destX;
		newSprite.y = destY;
		newSprite.scaleX = destW/sprite.w;
		newSprite.scaleY = (destH - clipH)/sprite.h;
		worldContainer.addChild(newSprite);	
	}
}

function renderBall(width, height, roadWidth, scale, destX, destY, offsetX, offsetY, clipY){
	var newSprite = $.sprites['ballMain'+gameData.ballIndex+'_'+gameData.ball.index].clone();
    var destW  = (newSprite.image.naturalWidth * scale * width/2) * (defaultData.scale * roadWidth);
    var destH  = (newSprite.image.naturalHeight * scale * width/2) * (defaultData.scale * roadWidth);
    destX = destX + (destW * (offsetX || 0));
    destY = destY + (destH * (offsetY || 0));
	
    var clipH = clipY ? Math.max(0, destY+destH-clipY) : 0;
    if (clipH < destH){
		newSprite.x = destX;
		newSprite.y = destY;
		newSprite.scaleX = destW/(newSprite.image.naturalWidth/2);
		newSprite.scaleY = (destH - clipH)/(newSprite.image.naturalHeight/2);
		worldContainer.addChild(newSprite);

		gameData.ball.x = destX;
		gameData.ball.y = destY;
	}
}

function renderParticle(width, height, roadWidth, sprite, scale, destX, destY, offsetX, offsetY, clipY){
	var newSprite = $.sprites[sprite.id].clone();
    var destW  = (newSprite.image.naturalWidth * scale * width/2) * (defaultData.scale * roadWidth);
    var destH  = (newSprite.image.naturalHeight * scale * width/2) * (defaultData.scale * roadWidth);
    destX = destX + (destW * (offsetX || 0));
    destY = destY + (destH * (offsetY || 0));
	
    var clipH = clipY ? Math.max(0, destY+destH-clipY) : 0;
    if (clipH < destH){
		newSprite.x = destX;
		newSprite.y = destY;
		newSprite.scaleX = destW/sprite.w;
		newSprite.scaleY = (destH - clipH)/sprite.h;
		worldContainer.addChild(newSprite);	
	}
}

function renderFog(x, y, width, height, fog){
	if (fog < 1) {
		var shape = new createjs.Shape();
		shape.graphics.beginFill(gameData.level.colorFog).drawRect(x, y, width, height);
		shape.alpha = (1-fog);
		worldContainer.addChild(shape);
    }
}


/*!
 * 
 * ROAD BUILD MISC - This is the function that runs for road build misc
 * 
 */
function rumbleWidth(projectedRoadWidth, lanes){
	return projectedRoadWidth/Math.max(6,  2*lanes);	
}

function laneMarkerWidth(projectedRoadWidth, lanes){
	return projectedRoadWidth/Math.max(32, 8*lanes);
}

/*!
 * 
 * START EXPLODE - This is the function that runs to start explode animation
 * 
 */
function startExplode(x,y,score){
	var totalExplode = gravityData.total;
	var explodeRange = 50;
	var speedX = 12;
	var speedY = [12,16];
	var scaleRange = [gameData.ball.w/10,gameData.ball.w/4];
	if(score){
		totalExplode = gravityData.totalScore;
		explodeRange = 30;
		speedX = 6;
		speedY = [6,12];
		scaleRange = [gameData.ball.w/10,gameData.ball.w/6];
	}
	for(var n=0; n<totalExplode; n++){
		var randomRadius = randomIntFromInterval(scaleRange[0], scaleRange[1]);
		var randomBallIndex = randomIntFromInterval(0,ballsSettings[gameData.ballIndex].balls.length-1);
		if(score){
			randomBallIndex = gameData.ball.index;
		}
		var newExplode = new createjs.Shape();	
		newExplode.graphics.beginFill(ballsSettings[gameData.ballIndex].balls[randomBallIndex].color).drawCircle(0,0,randomRadius);
		newExplode.x = x + randomIntFromInterval(-explodeRange, explodeRange);
		newExplode.y = y + randomIntFromInterval(-explodeRange, explodeRange);
		newExplode.xspeed = randomIntFromInterval(-speedX, speedX);
		newExplode.yspeed = randomIntFromInterval(-speedY[0], -speedY[1]);
		newExplode.scaleX = newExplode.scaleY = randomIntFromInterval(5, 10) * .1;
		newExplode.alpha = 1.5;
		newExplode.alphaspeed = randomIntFromInterval(2, 4) * .01;
		
		explodeContainer.addChild(newExplode);
		gameData.explodes.push(newExplode);
	}
}

function loopExplodes(){
	for(var n=0; n<gameData.explodes.length; n++){
		var thisExplode = gameData.explodes[n];	
		thisExplode.y = thisExplode.y + thisExplode.yspeed;
		thisExplode.x = thisExplode.x + thisExplode.xspeed;
		thisExplode.rotation = thisExplode.rotation + thisExplode.xspeed;

		thisExplode.yspeed = thisExplode.yspeed * gravityData.drag + gravityData.gravity;
		thisExplode.xspeed = thisExplode.xspeed * gravityData.drag;
		thisExplode.alpha -= thisExplode.alphaspeed;

		if(thisExplode.alpha < 0) {
			explodeContainer.removeChild(thisExplode);
			gameData.explodes.splice(n,1);
		}
	}
}

/*!
 * 
 * GAME SCORE - This is the function that runs for game score
 * 
 */
function updateGameScore(){
	gameScoreTxt.text = gameScoreShadowTxt.text = playerData.score;
	gameDistanceTxt.text = gameDistanceShadowTxt.text = addCommas(Math.floor(playerData.distance/gameData.distanceDivide)) + textStrings.miles;
}

/*!
 * 
 * END GAME - This is the function that runs for game end
 * 
 */
function endGame(){
	if(!gameData.over){
		gameData.over = true;
		gameData.action = false;
		if (window.__arcadeColorEnd) window.__arcadeColorEnd();

		playSound('soundFail');
		toggleInstruction(false);

		TweenMax.to(statusContainer, 1, {delay:1, alpha:1, overwrite:true, onComplete:function(){
			TweenMax.to(statusContainer, .5, {alpha:1, overwrite:true, onComplete:function(){
				goPage('result');
			}});
		}});
	}
}

/*!
 * 
 * UPDATE GAME - This is the function that runs to loop game update
 * 
 */
function updateGame(event){
	if(!gameData.paused){
		
	}

	updateWorld();
	loopExplodes();
	if (window.__arcadeColorTick) window.__arcadeColorTick();
}

/*!
 * 
 * GAME PAUSE - This is the function that runs for game pause
 * 
 */
function toggleGamePause(pause){
	gameData.loop = pause == true ? false : true;
	if(exitContainer.visible){
		gameData.loop = false;
		pause = true;
	}

	if(pause){
		TweenMax.pauseAll(true, true);
	}else{
		TweenMax.resumeAll(true, true)
	}
}

/*!
 * 
 * MILLISECONDS CONVERT - This is the function that runs to convert milliseconds to time
 * 
 */
function millisecondsToTimeGame(milli) {
	var milliseconds = milli % 1000;
	var seconds = Math.floor((milli / 1000) % 60);
	var minutes = Math.floor((milli / (60 * 1000)) % 60);
	
	if(seconds<10){
		seconds = '0'+seconds;  
	}
	
	if(minutes<10){
		minutes = '0'+minutes;  
	}
	
	return minutes+':'+seconds;
}

/*!
 * 
 * OPTIONS - This is the function that runs to toggle options
 * 
 */

function toggleOptions(con){
	if(optionsContainer.visible){
		optionsContainer.visible = false;
	}else{
		optionsContainer.visible = true;
	}
	if(con!=undefined){
		optionsContainer.visible = con;
	}
}


/*!
 * 
 * OPTIONS - This is the function that runs to mute and fullscreen
 * 
 */
function toggleSoundMute(con){
	buttonSoundOff.visible = buttonSoundOn.visible = false;
	toggleSoundInMute(con);
	if(con){
		buttonSoundOn.visible = true;
	}else{
		buttonSoundOff.visible = true;	
	}
}

function toggleMusicMute(con){
	buttonMusicOff.visible = buttonMusicOn.visible = false;
	toggleMusicInMute(con);
	if(con){
		buttonMusicOn.visible = true;
	}else{
		buttonMusicOff.visible = true;	
	}
}

function toggleFullScreen() {
  if (!document.fullscreenElement &&    // alternative standard method
      !document.mozFullScreenElement && !document.webkitFullscreenElement && !document.msFullscreenElement ) {  // current working methods
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    } else if (document.documentElement.msRequestFullscreen) {
      document.documentElement.msRequestFullscreen();
    } else if (document.documentElement.mozRequestFullScreen) {
      document.documentElement.mozRequestFullScreen();
    } else if (document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

/*!
 * 
 * SHARE - This is the function that runs to open share url
 * 
 */
function shareLinks(action, shareScore){
	if(shareSettings.gtag){
		gtag('event','click',{'event_category':'share','event_label':action});
	}

	var gameURL = location.href;
	gameURL = encodeURIComponent(gameURL.substring(0,gameURL.lastIndexOf("/") + 1));

	var shareTitle = shareSettings.shareTitle.replace("[SCORE]", shareScore);
	var shareText = shareSettings.shareText.replace("[SCORE]", shareScore);

	var shareURL = '';
	if( action == 'facebook' ){
		if(shareSettings.customScore){
			gameURL = decodeURIComponent(gameURL);
			shareURL = `https://www.facebook.com/sharer/sharer.php?u=`+encodeURIComponent(`${gameURL}share.php?title=${shareTitle}&url=${gameURL}&thumb=${gameURL}share.jpg`);
		}else{
			shareURL = `https://www.facebook.com/sharer/sharer.php?u=${gameURL}`;
		}
	}else if( action == 'twitter' ){
		shareURL = `https://twitter.com/intent/tweet?text=${shareText}&url=${gameURL}`;
	}else if( action == 'whatsapp' ){
		shareURL = `https://api.whatsapp.com/send?text=${shareText}%20${gameURL}`;
	}else if( action == 'telegram' ){
		shareURL = `https://t.me/share/url?url=${gameURL}&text=${shareText}`;
	}else if( action == 'reddit' ){
		shareURL = `https://www.reddit.com/submit?url=${gameURL}&title=${shareText}`;
	}else if( action == 'linkedin' ){
		shareURL = `https://www.linkedin.com/sharing/share-offsite/?url=${gameURL}`;
	}

	window.open(shareURL);
}