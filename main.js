// PixiJS
const { Application, live2d: { Live2DModel } } = PIXI;

// Kalidokit
const { Face, Vector: { lerp }, Utils: { clamp } } = Kalidokit;

const modelUrl = "./hiyori/hiyori_pro_t10.model3.json";
const videoElement = document.getElementById("my-video");

let currentModel, facemesh;
let latestRiggedFace = null;
let smoothRiggedFace = null;

// モーション再生管理
let isPlayingMotion = false;
let motionBlendFactor = 0;
let motionTimer = null;

(async function main() {
	// 1. PixiJSの準備（背景透過）
	const app = new PIXI.Application({
		view: document.getElementById("my-live2d"),
		autoStart: true,
		backgroundAlpha: 0,
		resizeTo: window
	});

	// 2. Live2Dモデルのロード（自動動作を完全にオフ）
	currentModel = await Live2DModel.from(modelUrl, { 
		autoInteract: false,
		autoUpdate: false // 自動モーション再生（Idleループ等）を完全に無効化
	});
	currentModel.scale.set(0.4);
	currentModel.interactive = true;
	currentModel.anchor.set(0.5, 0.5);
	currentModel.position.set(window.innerWidth * 0.5, window.innerHeight * 0.8);

	// 初期状態で勝手に動いているモーションをすべて強制停止
	currentModel.internalModel.motionManager.stopAllMotions();

	// ドラッグ・操作設定
	currentModel.on("pointerdown", e => {
		currentModel.offsetX = e.data.global.x - currentModel.position.x;
		currentModel.offsetY = e.data.global.y - currentModel.position.y;
		currentModel.dragging = true;
	});
	currentModel.on("pointerup", () => { currentModel.dragging = false; });
	currentModel.on("pointerupoutside", () => { currentModel.dragging = false; });
	currentModel.on("pointermove", e => {
		if (currentModel.dragging) {
			currentModel.position.set(
				e.data.global.x - currentModel.offsetX,
				e.data.global.y - currentModel.offsetY
			);
		}
	});

	// マウスホイール拡大縮小
	document.querySelector("#my-live2d").addEventListener("wheel", e => {
		e.preventDefault();
		const newScale = clamp(currentModel.scale.x + e.deltaY * -0.001, 0.1, 3.0);
		currentModel.scale.set(newScale);
	});

	app.stage.addChild(currentModel);

	// 3. 数字キー0〜9でキー押下（1回だけモーション再生）
	window.addEventListener("keydown", e => {
		if (e.repeat || !currentModel) return;

		if (e.key === "1") playCustomMotion("", 0); // hiyori_m01
		if (e.key === "2") playCustomMotion("", 1); // hiyori_m02
		if (e.key === "3") playCustomMotion("", 2); // hiyori_m03
		if (e.key === "4") playCustomMotion("", 3); // hiyori_m04
		if (e.key === "5") playCustomMotion("", 4); // hiyori_m05
		if (e.key === "6") playCustomMotion("", 5); // hiyori_m06
		if (e.key === "7") playCustomMotion("", 6); // hiyori_m07
		if (e.key === "8") playCustomMotion("", 7); // hiyori_m08
		if (e.key === "9") playCustomMotion("", 8); // hiyori_m09
		if (e.key === "0") playCustomMotion("", 9); // hiyori_m10
	});

	// 4. 毎フレームの更新ルーティン
	app.ticker.add((delta) => {
		if (!currentModel) return;

		// autoUpdate: false にしているため、手動で時間経過を適用
		const deltaTime = app.ticker.elapsedMS;

		if (isPlayingMotion) {
			// モーション再生中のみモーションアニメーションを1フレーム進める
			currentModel.update(deltaTime);
			return;
		}

		// モーション終了後、スムーズにトラッキングへ復帰
		if (motionBlendFactor < 1) {
			motionBlendFactor = Math.min(1, motionBlendFactor + 0.05 * delta);
		}

		// トラッキング（Kalidokit）適用
		if (latestRiggedFace) {
			smoothRiggedFace = smoothFaceData(smoothRiggedFace, latestRiggedFace, 0.25 * delta);
			applyRig(currentModel, smoothRiggedFace, 0.2 * delta, motionBlendFactor);
		}

		// モデル全体の最終パラメータ適用更新
		currentModel.update(deltaTime);
	});

	// 5. MediaPipe FaceMesh
	facemesh = new FaceMesh({
		locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
	});
	facemesh.setOptions({
		maxNumFaces: 1,
		refineLandmarks: true,
		minDetectionConfidence: 0.5,
		minTrackingConfidence: 0.5
	});
	facemesh.onResults(onResults);

	// 6. カメラ開始
	startCamera();
})();

// 特定のキーで1回だけモーションを再生する関数
const playCustomMotion = async (group, index = 0) => {
	if (!currentModel) return;

	if (motionTimer) clearTimeout(motionTimer);

	// 既存モーションを停止して初期化
	currentModel.internalModel.motionManager.stopAllMotions();

	isPlayingMotion = true;
	motionBlendFactor = 0;

	// モーション開始
	const motionValue = await currentModel.motion(group, index, 3);

	if (motionValue) {
		const duration = motionValue._duration || motionValue.duration || 3000;

		// モーションの長さ（ミリ秒）が過ぎたら確実に停止してトラッキングに戻す
		motionTimer = setTimeout(() => {
			currentModel.internalModel.motionManager.stopAllMotions();
			isPlayingMotion = false;
		}, duration);
	} else {
		isPlayingMotion = false;
	}
};

// カメラのトラッキング結果受信
const onResults = results => {
	const points = results.multiFaceLandmarks ? results.multiFaceLandmarks[0] : null;
	
	if (points) {
		latestRiggedFace = Face.solve(points, {
			runtime: "mediapipe",
			video: videoElement
		});
	} else {
		latestRiggedFace = null;
	}
};

// 動きを滑らかにするデータ平滑化処理（EMAフィルタ）
const smoothFaceData = (oldData, newData, factor) => {
	if (!oldData) return newData;
	const f = clamp(factor, 0.05, 1);
	return {
		pupil: {
			x: lerp(oldData.pupil.x, newData.pupil.x, f),
			y: lerp(oldData.pupil.y, newData.pupil.y, f)
		},
		head: {
			degrees: {
				x: lerp(oldData.head.degrees.x, newData.head.degrees.x, f),
				y: lerp(oldData.head.degrees.y, newData.head.degrees.y, f),
				z: lerp(oldData.head.degrees.z, newData.head.degrees.z, f)
			},
			y: lerp(oldData.head.y, newData.head.y, f)
		},
		eye: {
			l: lerp(oldData.eye.l, newData.eye.l, f),
			r: lerp(oldData.eye.r, newData.eye.r, f)
		},
		mouth: {
			x: lerp(oldData.mouth.x, newData.mouth.x, f),
			y: lerp(oldData.mouth.y, newData.mouth.y, f)
		}
	};
};

// Live2Dモデルへのパラメータ反映
const applyRig = (model, result, lerpAmount, blendFactor = 1) => {
	const coreModel = model.internalModel.coreModel;
	model.internalModel.eyeBlink = undefined;

	const setParam = (id, targetVal) => {
		const currentVal = coreModel.getParameterValueById(id);
		const finalTarget = lerp(currentVal, targetVal, blendFactor);
		coreModel.setParameterValueById(id, lerp(currentVal, finalTarget, lerpAmount));
	};

	// 視線
	setParam("ParamEyeBallX", result.pupil.x);
	setParam("ParamEyeBallY", result.pupil.y);

	// 頭部の回転（ミラーリング）
	setParam("ParamAngleX", -result.head.degrees.y);
	setParam("ParamAngleY", result.head.degrees.x);
	setParam("ParamAngleZ", -result.head.degrees.z);

	// 体の連動
	const dampener = 0.3;
	setParam("ParamBodyAngleX", -result.head.degrees.y * dampener);
	setParam("ParamBodyAngleY", result.head.degrees.x * dampener);
	setParam("ParamBodyAngleZ", -result.head.degrees.z * dampener);

	// 目と口
	const currentEyeL = coreModel.getParameterValueById("ParamEyeLOpen");
	const currentEyeR = coreModel.getParameterValueById("ParamEyeROpen");
	
	let stabilizedEyes = Face.stabilizeBlink(
		{
			l: lerp(currentEyeL, result.eye.l, lerpAmount),
			r: lerp(currentEyeR, result.eye.r, lerpAmount)
		},
		result.head.y
	);

	setParam("ParamEyeLOpen", stabilizedEyes.l);
	setParam("ParamEyeROpen", stabilizedEyes.r);

	setParam("ParamMouthOpenY", result.mouth.y);
	setParam("ParamMouthForm", 0.3 + result.mouth.x);
};

// Webカメラ起動
const startCamera = () => {
	const camera = new Camera(videoElement, {
		onFrame: async () => {
			await facemesh.send({ image: videoElement });
		},
		width: 640,
		height: 480
	});
	camera.start();
};
