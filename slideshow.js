// Current Slide
let slideIndex = 0;

// Automatic slideshow
const slideTimer = 5000;
var slideAdvance = setInterval(() => {
  slideIndex ++;
  showSlides(slideIndex);
}, slideTimer);

// Prev / next controls
function plusSlides(n) {
  clearInterval(slideAdvance)
  slideIndex += n;
  showSlides(slideIndex);
}

// Dot controls
function currentSlide(n) {
  clearInterval(slideAdvance);
  slideIndex = n;
  showSlides(slideIndex);
}

function showSlides(n) {
  // Get all slides
  let $slides = $(".current-project .slide");
  let $dots = $(".current-project .dot");

  // Make sure index in bounds
  if(slideIndex == $slides.length){
    slideIndex = 0;
  }
  if(slideIndex == -1){
    slideIndex = $slides.length-1;
  }

  // Enable current slide, disable all others
  $slides.each(function(index) {
    if(index === slideIndex) {
      $(this).css("display", "block");
    } else {
      $(this).css("display", "none");
    }
  })

  // Enable current dot, disable all others
  $dots.each(function(index) {
    if(index === slideIndex) {
      $(this).addClass("active");
    } else {
      $(this).removeClass("active");
    }
  })
}

function showProject(project) {
  $(".container-project").each(function() {
    $(this).removeClass("current-project")  
  })
  $("#"+project).addClass("current-project")

  $(".chip").each(function() {
    $(this).removeClass("active")
  })
  $(".chip." + project).addClass("active")

  slideIndex = 0
}