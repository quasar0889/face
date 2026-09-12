// PixiJS
const { Application, live2d: { Live2DModel } } = PIXI;

// Kalidokit
const { Face, Vector: { lerp }, Utils: { clamp } } = Kalidokit;

const modelUrl = "./hiyori/hiyori_pro_t10.model3.json";
const videoElement = document.getElementById("my-video");

let currentModel, facemesh;
let latestRiggedFace = null;
let smoothRiggedFace = null; // ぬるぬる化用の保持データ

// モーション再生管理フラグ
let isPlayingMotion = false;
let motionBlendFactor = 0; // 0: モーション優先, 1: トラッキング完全復帰

(async function main() {
	// 1. PixiJSの準備（背景透過）
	const app = new PIXI.Application({
		view: document.getElementById("my-live2d"),
		autoStart: true,
		backgroundAlpha: 0, // 透過キャンバス
		resizeTo: window
	});

	// 2. Live2Dモデルのロード
	currentModel = await Live2DModel.from(modelUrl, { autoInteract: false });
	currentModel.scale.set(0.4);
	currentModel.interactive = true;
	currentModel.anchor.set(0.5, 0.5);
	currentModel.position.set(window.innerWidth * 0.5, window.innerHeight * 0.8);

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

	// モーション再生終了イベントの検知
	currentModel.internalModel.motionManager.on("motionFinish", () => {
		isPlayingMotion = false;
	});

	// 3. 数字キー0〜9でひよりちゃんのモーション（hiyori_m01〜m10）を再生
	window.addEventListener("keydown", e => {
		if (e.repeat || !currentModel) return;

		// Hiyoriモデルのグループ名は空文字 "" です
		if (e.key === "1") playCustomMotion("", 0); // hiyori_m01
		if (e.key === "2") playCustomMotion("", 1); // hiyori_m02
		if (e.key === "3") playCustomMotion("", 2); // hiyori_m03
		if (e.key === "4") playCustomMotion("", 3); // hiyori_m04
		if (e.key === "5") playCustomMotion("", 5); // hiyori_m05
		if (e.key === "6") playCustomMotion("", 5); // hiyori_m06
		if (e.key === "7") playCustomMotion("", 6); // hiyori_m07
		if (e.key === "8") playCustomMotion("", 7); // hiyori_m08
		if (e.key === "9") playCustomMotion("", 8); // hiyori_m09
		if (e.key === "0") playCustomMotion("", 9); // hiyori_m10
	});

	// 4. 毎フレームの描画・制御ルーティン（ぬるぬる補間・修正版）
	app.ticker.add((delta) => {
		if (!currentModel) return;

		const motionManager = currentModel.internalModel.motionManager;
		// モーション再生中かどうか判定（isFinishedがfalseなら再生中）
		const isExecutingMotion = motionManager.isFinished ? !motionManager.isFinished() : isPlayingMotion;

		if (isPlayingMotion && isExecutingMotion) {
			// モーション再生中はトラッキング処理を実行しない（モーションを優先）
			return;
		} else if (isPlayingMotion && !isExecutingMotion) {
			// モーション終了を検知してフラグを下ろす
			isPlayingMotion = false;
		}

		// モーション終了直後の滑らかなトラッキング復帰（フェードイン）
		if (motionBlendFactor < 1) {
			motionBlendFactor = Math.min(1, motionBlendFactor + 0.05 * delta);
		}

		if (latestRiggedFace) {
			// 指数移動平均フィルタ（EMA）によるノイズ軽減
			smoothRiggedFace = smoothFaceData(smoothRiggedFace, latestRiggedFace, 0.25 * delta);
			applyRig(currentModel, smoothRiggedFace, 0.2 * delta, motionBlendFactor);
		}
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

// 特定のキーでモーションを再生する関数（修正版）
const playCustomMotion = async (group, index = 0) => {
	if (!currentModel) return;

	const motionManager = currentModel.internalModel.motionManager;

	isPlayingMotion = true;
	motionBlendFactor = 0; // トラッキングによる上書きを遮断

	// 優先度 FORCE (3) かつ loop を false に設定して単発再生を指示
	const success = await motionManager.startMotion(group, index, 3, false);
	if (!success) {
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

// 動きをぬるぬるにするデータ平滑化処理（EMAフィルタ）
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
	model.internalModel.eyeBlink = undefined; // 自動まばたきオフ

	const setParam = (id, targetVal) => {
		const currentVal = coreModel.getParameterValueById(id);
		const finalTarget = lerp(currentVal, targetVal, blendFactor);
		coreModel.setParameterValueById(id, lerp(currentVal, finalTarget, lerpAmount));
	};

	// 視線
	setParam("ParamEyeBallX", result.pupil.x);
	setParam("ParamEyeBallY", result.pupil.y);

	// 頭部の回転（Webカメラと向きを合わせるミラーリング）
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
